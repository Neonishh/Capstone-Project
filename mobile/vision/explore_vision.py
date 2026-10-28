"""
explore_vision.py
Architecture B — Full Vision Pipeline with LLM Reasoning

Loop (configurable step budget):
  Screenshot → YOLO → OCR → Merge → LLM decides action
  → Exploration Controller executes via Appium → repeat

Usage:
  python vision/explore_vision.py
  python vision/explore_vision.py --app-package com.example.app --app-activity .MainActivity

Environment variables:
  LLM_PROVIDER=ollama   (default) | groq | gemini | openai
  OLLAMA_MODEL=llama3.1
  APPIUM_HOST=localhost
  APPIUM_PORT=4723
"""

import argparse
import json
import os
import sys
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent.parent / ".env")
except ImportError:
    pass

from vision.screenshot_capture import capture_screenshot
from vision.yolo_detector import detect_ui_components
from vision.ocr_extractor import extract_text, needs_ocr
from vision.vision_merger import merge
from vision.llm_reasoner import decide_next_action
from vision.accessibility_extractor import extract_accessibility
from vision.coordinate_mapper import map_bbox_center, annotate_tap
from vision.action_verification import verify_action
from vision.test_case_generator import generate_test_cases, write_run_summary
from src.database_storage import MobileRun, add_database_arguments, write_exploration_metadata
from vision.app_state import launch_start
from vision.quality import Coverage, screen_key, requirement_cases, wait_for_screen, exploration_target, input_target
from vision.behavior_planner import BehaviorPlanner
from vision.oracles import check_oracle

MAX_STEPS   = 30
APPIUM_HOST = os.environ.get("APPIUM_HOST", "localhost")
APPIUM_PORT = int(os.environ.get("APPIUM_PORT", 4723))

# Each invocation owns a separate output directory so later runs cannot
# overwrite screenshots, per-screen JSON, or the memory log from earlier runs.
RUN_ID          = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S_%fZ")
VISION_DIR      = Path(__file__).parent.parent / "logs" / "vision" / RUN_ID
SCREENSHOTS_DIR = VISION_DIR / "screenshots"
JSON_DIR        = VISION_DIR / "json"
DEBUG_DIR       = VISION_DIR / "debug"
MEMORY_LOG_PATH = str(VISION_DIR / "vision_memory_log.json")

DEFAULT_APP_PACKAGE  = "com.android.settings"
DEFAULT_APP_ACTIVITY = ".Settings"


# ── Appium setup ──────────────────────────────────────────────────────────────

def build_driver(app_package: str, app_activity: str):
    from appium import webdriver
    from appium.options.android import UiAutomator2Options

    options = UiAutomator2Options()
    options.platform_name          = "Android"
    options.app_package            = app_package
    options.app_activity           = app_activity
    options.no_reset               = True
    options.auto_grant_permissions = True
    options.new_command_timeout    = 300
    options.set_capability("appium:adbExecTimeout", 60000)
    options.set_capability("appium:uiautomator2ServerReadTimeout", 30000)
    options.app_wait_activity      = "*"

    appium_url = f"http://{APPIUM_HOST}:{APPIUM_PORT}"
    print(f"[explore_vision] Connecting to Appium at {appium_url}...")
    driver = webdriver.Remote(appium_url, options=options)
    driver.update_settings({"waitForIdleTimeout": 1000, "waitForSelectorTimeout": 3000})
    print("[explore_vision] Connected.")
    return driver


# ── Exploration Controller ────────────────────────────────────────────────────

def execute_action(driver, action: dict) -> dict:
    """
    Receives the LLM's action decision and executes it on the device.

    Coordinates from YOLO/OCR are in screenshot pixel space. This function
    scales them to device screen space before tapping, so the tap lands on
    the correct element regardless of screenshot vs screen resolution mismatch.
    """
    action_type = action.get("action", "done")

    if action_type == "done":
        return {"status": "not_needed"}

    if action_type == "relaunch":
        launch_start(driver, action["app_package"], action["app_activity"])
        return {"status": "executed", "method": "relaunch"}
    if action_type == "observe":
        return {"status": "executed", "method": "observe"}

    if action_type == "back":
        driver.back()
        time.sleep(0.5)
        return {"status": "executed", "method": "back"}

    if action_type == "swipe":
        _do_swipe(driver, action.get("direction", "up"), action.get("swipe_region"), action.get("duration_ms", 500))
        return {"status": "executed", "method": "swipe"}

    bbox = action.get("bbox")
    if bbox is None:
        print("[explore_vision] No valid target bbox; action skipped")
        return {"status": "skipped", "reason": "no_valid_target_bbox"}

    screenshot_path = action.get("_screenshot_path", "")
    if not screenshot_path:
        return {"status": "skipped", "reason": "missing_source_screenshot"}

    geometry = map_bbox_center(driver, screenshot_path, bbox)
    shot_x, shot_y = geometry["screenshot_point"]
    cx, cy = geometry["device_point"]

    print(f"[explore_vision] Tapping ({cx}, {cy})")

    if action_type == "tap":
        driver.tap([(cx, cy)])

    elif action_type == "drag":
        destination = map_bbox_center(driver, screenshot_path, action["destination_bbox"])["device_point"]
        driver.execute_script("mobile: dragGesture", {"startX": cx, "startY": cy,
                              "endX": destination[0], "endY": destination[1], "speed": 500})

    elif action_type == "type":
        driver.tap([(cx, cy)])
        time.sleep(0.3)
        value = action.get("value", "")
        if action.get("clear"):
            driver.switch_to.active_element.clear()
        if value:
            driver.switch_to.active_element.send_keys(value)
        if action.get("hide_keyboard", True):
            try:
                if driver.is_keyboard_shown():
                    driver.hide_keyboard()
            except Exception:
                pass
    else:
        return {"status": "skipped", "reason": f"unsupported_action:{action_type}"}

    debug_dir = Path(action.get("_debug_dir") or DEBUG_DIR)
    debug_path = annotate_tap(
        screenshot_path,
        bbox,
        (shot_x, shot_y),
        f"{action_type}: {action.get('target', '')}",
        debug_dir / f"step_{int(action.get('_step', 0)):02d}_tap.png",
    )
    if geometry["aspect_ratio_mismatch"]:
        print("[explore_vision] WARNING screenshot/tap-space aspect ratios differ; inspect the debug tap overlay")
    return {
        "status": "executed",
        "method": action_type,
        "tap": geometry,
        "tap_overlay": debug_path,
    }


def _checkable_states(elements: list) -> dict:
    """Map checkable controls to their current state for action auditing."""
    states = {}
    for element in elements:
        if not element.get("checkable"):
            continue
        key = "|".join((
            element.get("resource_id", ""),
            element.get("text", ""),
            str(element.get("bbox", "")),
        ))
        states[key] = {
            "text": element.get("text", ""),
            "checked": bool(element.get("checked")),
        }
    return states


def _screen_name(elements: list) -> str:
    """Infer a screen title from the largest labelled accessibility node."""
    labelled = [el for el in elements if el.get("text") and el.get("bbox")]
    if not labelled:
        return "unknown"
    titled = [el for el in labelled if el.get("is_title")]
    if titled:
        return titled[0].get("text") or "unknown"
    labelled = [el for el in labelled if not (el.get("clickable") or el.get("checkable"))
                and 80 <= el["bbox"][1] < 600]
    if not labelled:
        return "unknown"
    title = max(
        labelled,
        key=lambda el: (el["bbox"][2] - el["bbox"][0]) *
                       (el["bbox"][3] - el["bbox"][1]),
    )
    return title.get("text") or "unknown"


def _fallback_action(screen_data: dict, history: list) -> dict:
    """Choose a fresh accessible control if the LLM call fails."""
    tried = {
        " ".join(str(entry.get("target") or "").casefold().split())
        for entry in history
        if entry.get("action") in {"tap", "type"}
    }
    candidates = []
    for index, element in enumerate(screen_data.get("elements", [])):
        if not (element.get("clickable") or element.get("checkable")):
            continue
        text = " ".join(str(element.get("text") or "").split())
        if not text or text.startswith("[REDACTED]"):
            continue
        normalized = text.casefold()
        if normalized in tried:
            continue
        candidates.append((index, element, normalized))

    # Search controls are often present on every Settings screen and can
    # prevent exploration of the actual screen rows.
    non_search = [item for item in candidates if "search" not in item[2]]
    if non_search:
        candidates = non_search

    if candidates:
        index, element, _ = candidates[0]
        return {
            "action": "tap",
            "element_index": index,
            "target": element.get("text", ""),
            "bbox": element.get("bbox"),
            "value": "",
            "reason": "fallback_after_llm_error",
        }

    return {
        "action": "swipe",
        "element_index": None,
        "target": "",
        "bbox": None,
        "value": "",
        "reason": "fallback_after_llm_error_no_untried_control",
    }


def _do_swipe(driver, direction="up", region=None, duration=500) -> None:
    size = driver.get_window_size()
    w, h = size["width"], size["height"]
    gestures = {"up": (.5,.7,.5,.3), "down": (.5,.3,.5,.7),
                "left": (.85,.5,.15,.5), "right": (.15,.5,.85,.5)}
    if direction not in gestures:
        raise ValueError("Unsupported swipe direction")
    x1,y1,x2,y2 = gestures[direction]
    if region is not None:
        if len(region) != 4 or not all(isinstance(v, (int,float)) and 0 <= v <= 1 for v in region):
            raise ValueError("Swipe region must contain normalized x, y, width and height")
        left,top,width,height = region
        if width <= 0 or height <= 0 or left+width > 1 or top+height > 1:
            raise ValueError("Swipe region extends outside the viewport")
        x1,x2 = left + width*x1, left + width*x2
        y1,y2 = top + height*y1, top + height*y2
    driver.swipe(int(w*x1), int(h*y1), int(w*x2), int(h*y2), duration=max(150, min(1500, int(duration))))


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Vision Pipeline — Architecture B")
    parser.add_argument("--app-package",  default=DEFAULT_APP_PACKAGE)
    parser.add_argument("--app-activity", default=DEFAULT_APP_ACTIVITY)
    parser.add_argument(
        "--execute-generated", action="store_true",
        help="Replay generated cases and save the execution report in this run folder.",
    )
    parser.add_argument("--max-steps", type=int, default=MAX_STEPS)
    parser.add_argument("--allow-package", action="append", default=[], help="Additional Android package allowed during exploration")
    parser.add_argument("--requirements", help="JSON requirement scenarios with explicit oracles")
    parser.add_argument("--behavior-profile", choices=["auto", "off"], default="auto",
                        help="Exercise known app functional workflows before free exploration (default: auto)")
    parser.add_argument("--profile-only", action="store_true",
                        help="Stop after the available functional profile; do not make model requests")
    add_database_arguments(parser)
    args = parser.parse_args()
    if args.max_steps < 1:
        parser.error("--max-steps must be positive")
    specified_cases = requirement_cases(args.requirements) if args.requirements else []
    coverage = Coverage()
    behavior = BehaviorPlanner(args.app_package, args.app_activity, args.behavior_profile == "auto")
    if args.profile_only and not behavior.pending:
        parser.error("--profile-only requires an available app behavior profile")
    exploration_policy = "functional_profile_then_model" if behavior.pending else "model_with_controlled_inputs"
    fixture_state = {}
    model_calls = 0
    free_exploration_started = False
    allowed_packages = {args.app_package, *args.allow_package}
    # Pixel/Google Settings delegates its built-in search to this companion app.
    if args.app_package == "com.android.settings":
        allowed_packages.add("com.google.android.settings.intelligence")
    exploration_error = None
    finalization_error = None
    exploration_stop_reason = "step_budget"
    exploration_complete = False

    if os.environ.get("LLM_PROVIDER", "ollama").lower() == "gemini":
        from src.gemini_client import generate
        json.loads(generate('Return exactly this JSON object: {"ready":true}'))
        print("[explore_vision] Gemini connection verified")

    SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    JSON_DIR.mkdir(parents=True, exist_ok=True)
    DEBUG_DIR.mkdir(parents=True, exist_ok=True)
    print(f"  Run output: {VISION_DIR}")

    print("=" * 55)
    print(" Architecture B — Vision Pipeline (PES University 101)")
    print(f"  App      : {args.app_package}/{args.app_activity}")
    print(f"  Steps    : {args.max_steps}")
    print(f"  Provider : {os.environ.get('LLM_PROVIDER', 'ollama')}")
    print("=" * 55)

    driver = build_driver(args.app_package, args.app_activity)

    exploration_history = []   # grows with each step — passed to LLM each time

    try:
        launch_start(driver, args.app_package, args.app_activity)
        (VISION_DIR / "run_config.json").write_text(json.dumps({
            "app_package": args.app_package, "app_activity": args.app_activity,
            "provider": os.environ.get("LLM_PROVIDER", "ollama"),
            "model": {
                "gemini": os.environ.get("GEMINI_MODEL", "gemini-2.5-flash"),
                "openai": os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
                "groq": os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile"),
                "ollama": os.environ.get("OLLAMA_MODEL", "llama3.1"),
            }.get(os.environ.get("LLM_PROVIDER", "ollama").lower()),
            "max_steps": args.max_steps, "allowed_packages": sorted(allowed_packages),
            "behavior_profile": args.behavior_profile,
            "profile_only": args.profile_only,
            "exploration_policy": exploration_policy,
        }, indent=2), encoding="utf-8")
        for step in range(1, args.max_steps + 1):
            if args.profile_only and not behavior.active and not behavior.pending:
                exploration_stop_reason = "functional_profile_complete"
                break
            print(f"\n======== Vision Step {step} / {args.max_steps} ========")

            # ── Module 1: Screenshot ──────────────────────────────────────
            accessibility_results, before_settle = wait_for_screen(driver, extract_accessibility)
            current_screen_key = screen_key(accessibility_results, driver.current_activity)
            recovery_reason = coverage.recovery(current_screen_key, driver.current_package, allowed_packages)
            if (behavior.active or behavior.pending) and recovery_reason in {"three_actions_without_progress", "screen_visit_budget_exhausted"}:
                recovery_reason = None  # Multi-field workflows have their own bounded step/target budget.
            if not before_settle["settled"]:
                recovery_reason = recovery_reason or "screen_did_not_settle"
            if recovery_reason:
                exploration_history.append({"step": step, "action": "restart", "reason": recovery_reason,
                                            "package_before": driver.current_package})
                print(f"[explore_vision] Recovery: {recovery_reason}; returning to start")
                launch_start(driver, args.app_package, args.app_activity)
                fixture_state.clear()
                coverage.recovered(current_screen_key)
                continue
            screenshot_path = capture_screenshot(driver, str(SCREENSHOTS_DIR), step)

            # ── Module 2: YOLO ────────────────────────────────────────────
            try:
                yolo_results = detect_ui_components(screenshot_path)
            except Exception as e:
                print(f"[explore_vision] YOLO failed: {e}")
                yolo_results = []

            # ── Module 3: OCR ─────────────────────────────────────────────
            try:
                ocr_results = extract_text(screenshot_path) if needs_ocr(accessibility_results) else []
            except Exception as e:
                print(f"[explore_vision] OCR failed: {e}")
                ocr_results = []

            screen_data = merge(
                step=step,
                screenshot_path=screenshot_path,
                yolo_detections=yolo_results,
                ocr_results=ocr_results,
                output_dir=str(JSON_DIR),
                accessibility_results=accessibility_results,
            )

            # ── Module 5: LLM decides next action ─────────────────────────
            try:
                screen_data["coverage_screen_key"] = screen_key(accessibility_results, driver.current_activity)
                size = driver.get_window_size()
                action = behavior.next_action(screen_data.get("elements", []), (size["width"], size["height"]))
                if action is None:
                    if behavior.completed and not free_exploration_started:
                        launch_start(driver, args.app_package, args.app_activity)
                        fixture_state.clear()
                        exploration_history.append({"step": step, "action": "restart", "reason": "begin_free_exploration"})
                        free_exploration_started = True
                        continue
                    model_screen = dict(screen_data)
                    model_screen["elements"] = [dict(el, clickable=False, checkable=False, editable=False)
                        if not (exploration_target(el, driver.current_package) or input_target(el, driver.current_package)) else el
                        for el in screen_data.get("elements", [])]
                    model_calls += 1
                    action = decide_next_action(model_screen, exploration_history)
            except Exception as e:
                print(f"[explore_vision] LLM failed: {e}")
                (VISION_DIR / "llm_error.json").write_text(json.dumps({
                    "step": step, "error": str(e), "type": type(e).__name__,
                }, indent=2), encoding="utf-8")
                raise RuntimeError("Exploration stopped after LLM failure; no fallback tests generated") from e

            current_screen_key = screen_key(accessibility_results, driver.current_activity)
            if action.get("_behavior_id"):
                coverage.visit(current_screen_key, action, screen_data.get("elements", []))
            else:
                action = coverage.choose(current_screen_key, action, screen_data.get("elements", []), driver.current_package)

            log_entry = {
                "step":       step,
                "screen_key": current_screen_key,
                "state_key": current_screen_key + json.dumps(fixture_state, sort_keys=True),
                "activity_before": driver.current_activity,
                "package_before": driver.current_package,
                "settle_before": before_settle,
                "screen":     screen_data.get("screen", "unknown"),
                "screenshot": screenshot_path,
                "action":     action.get("action"),
                "target":     action.get("target", ""),
                "bbox":       action.get("bbox"),
                "value":      "[REDACTED]" if action.get("action") == "type" else action.get("value", ""),
                "reason":     action.get("reason", ""),
                "timestamp":  datetime.now(timezone.utc).isoformat(),
                "elements_detected": len(screen_data.get("elements", [])),
                "detection_counts": screen_data.get("detection_counts", {}),
                "execution": {"status": "not_executed"},
                "decision_source": "app_profile" if action.get("_behavior_id") else "model_with_controller",
            }
            if action.get("input_fixture"):
                log_entry.update(input_fixture=action["input_fixture"], clear=True)
            if action.get("_behavior_id"):
                log_entry["behavior_id"] = action["_behavior_id"]
            if action.get("direction"):
                log_entry["direction"] = action["direction"]
            action_index = action.get("element_index")
            selected = (
                screen_data["elements"][action_index]
                if isinstance(action_index, int) and 0 <= action_index < len(screen_data["elements"])
                else None
            )
            if selected:
                bbox = selected.get("bbox") or action.get("bbox")
                try:
                    from PIL import Image

                    with Image.open(screenshot_path) as screenshot:
                        width, height = screenshot.size
                    norm_center = [
                        round((bbox[0] + bbox[2]) / (2 * width), 5),
                        round((bbox[1] + bbox[3]) / (2 * height), 5),
                    ] if bbox and width and height else None
                except Exception:
                    norm_center = None
                log_entry["target_control"] = {
                    "text": selected.get("text", ""),
                    "resource_id": selected.get("resource_id", ""),
                    "accessibility_id": selected.get("accessibility_id", ""),
                    "password": bool(selected.get("password")),
                    "clickable": bool(selected.get("clickable")),
                    "checkable": bool(selected.get("checkable")),
                    "checked_before": bool(selected.get("checked")),
                    "control_type": selected.get("control_class") or selected.get("type", ""),
                    "editable": bool(selected.get("editable")),
                    "bbox": bbox,
                    "norm_center": norm_center,
                }
            before_states = _checkable_states(screen_data.get("elements", []))
            exploration_history.append(log_entry)
            print(f"[explore_vision] Logged step {step}")

            # ── Stop if LLM says done ──────────────────────────────────────
            if action.get("action") == "done":
                exploration_stop_reason = "agent_done"
                exploration_complete = True
                print("[explore_vision] LLM returned 'done' — stopping early")
                break

            # ── Exploration Controller executes action ─────────────────────
            if action.get("action") != "done":
                try:
                    activity_before = driver.current_activity
                    action["_screenshot_path"] = screenshot_path
                    action["_debug_dir"] = str(DEBUG_DIR)
                    action["_step"] = step
                    execution = execute_action(driver, action)
                    if action.get("action") == "relaunch":
                        fixture_state.clear()
                    elif action.get("input_fixture") and selected:
                        identity = selected.get("accessibility_id") or selected.get("resource_id") or selected.get("text", "")
                        fixture_state[identity] = action["input_fixture"]
                    after_accessibility, settle = wait_for_screen(driver, extract_accessibility)
                    activity_after = driver.current_activity
                    package_after = driver.current_package
                    screenshot_after = capture_screenshot(driver, str(SCREENSHOTS_DIR), step, suffix="after")
                    after_states = _checkable_states(after_accessibility)
                    changed_states = {
                        key: {"before": before_states.get(key), "after": after_states.get(key)}
                        for key in before_states.keys() | after_states.keys()
                        if before_states.get(key) != after_states.get(key)
                    }
                    verification = verify_action(
                        screenshot_path,
                        screenshot_after,
                        _screen_name(accessibility_results),
                        _screen_name(after_accessibility),
                        accessibility_results,
                        after_accessibility,
                        action.get("bbox"),
                        activity_before=activity_before,
                        activity_after=activity_after,
                    ) if execution.get("status") == "executed" else {
                        "changed": False,
                        "evidence": [],
                        "reason": execution.get("reason", "action_not_executed"),
                    }
                    execution.update({
                        "screenshot_after": screenshot_after,
                        "screen_after": _screen_name(after_accessibility),
                        "checkable_states_before": before_states,
                        "checkable_states_after": after_states,
                        "state_changes": changed_states,
                        "verification": verification,
                        "effect_detected": verification.get("changed", False),
                        "activity_after": activity_after,
                        "package_after": package_after,
                        "in_scope": package_after in allowed_packages,
                        "settle": settle,
                        "screen_key_after": screen_key(after_accessibility, activity_after),
                        "state_key_after": screen_key(after_accessibility, activity_after) + json.dumps(fixture_state, sort_keys=True),
                        "controls_after": [{k: el.get(k) for k in ("text", "resource_id", "accessibility_id", "hint", "value", "password", "checked", "checkable", "editable", "package", "control_class")} for el in after_accessibility],
                        "destination_titles": [el["text"] for el in after_accessibility
                                               if el.get("is_title") and el.get("text")],
                        "selected_value_after": (
                            selected.get("text") if selected and selected.get("checkable")
                            and any(el.get("text") == selected.get("text") for el in after_accessibility)
                            else None
                        ),
                        "visible_text_after": sorted({str(el.get("text")) for el in after_accessibility
                                                      if el.get("text") and not el.get("editable")
                                                      and not str(el.get("resource_id", "")).endswith("/summary")}),
                    })
                    log_entry["execution"] = execution
                    assertion = None
                    if behavior.final_step(action):
                        ok, detail = check_oracle(behavior.active, {}, after_accessibility, verification, activity_after)
                        assertion = {"ok": ok, **detail}
                        execution["behavior_assertion"] = assertion
                    behavior.record(action, execution, step, assertion)
                    if selected and selected.get("checkable") and execution.get("status") == "executed" and not action.get("_behavior_id"):
                        from vision.target_matcher import resolve_target
                        from PIL import Image
                        with Image.open(screenshot_after) as image:
                            after_size = image.size
                        target = log_entry["target_control"]
                        live, _ = resolve_target(target, after_accessibility, after_size, "tap")
                        if live is None:
                            raise RuntimeError("Cannot restore explored checkable control")
                        if live.get("checked") != target["checked_before"]:
                            restore = dict(action="tap", bbox=live["bbox"], target=target.get("text", ""),
                                           _screenshot_path=screenshot_after, _step=step)
                            execute_action(driver, restore)
                            time.sleep(1)
                            restored = extract_accessibility(driver)
                            live, _ = resolve_target(target, restored, after_size, "tap")
                            if live is None or live.get("checked") != target["checked_before"]:
                                raise RuntimeError("Exploration cleanup did not restore checked state")
                        execution["exploration_cleanup"] = "restored"
                        launch_start(driver, args.app_package, args.app_activity)
                        exploration_history.append({"action": "restart", "step": step, "reason": "fixture_restored"})
                    coverage.record(bool(action.get("input_fixture")) or bool(verification.get("checkable_state_changes")) or
                                    log_entry["screen_key"] != execution["screen_key_after"])
                except Exception as e:
                    print(f"[explore_vision] Execute failed: {e} — continuing")
                    coverage.record(False)
                    log_entry["execution"] = {"status": "error", "error": str(e)}
                    behavior.record(action, log_entry["execution"], step)
                    if selected and selected.get("checkable") and not action.get("_behavior_id"):
                        exploration_error = "Checkable cleanup or execution failed: " + str(e)
                        exploration_stop_reason = "execution_error"
                        break

    except KeyboardInterrupt:
        exploration_error = "Run cancelled by user"
        exploration_stop_reason = "cancelled"
        exploration_complete = False
        args.execute_generated = False
    except Exception as fatal:
        exploration_error = str(fatal)
        exploration_stop_reason = "rate_limit" if "429" in str(fatal.__cause__ or fatal) else "error"
        exploration_complete = False
        print(f"\n[explore_vision] FATAL: {fatal}")
        import traceback
        traceback.print_exc()

    finally:
        # Save memory log
        VISION_DIR.mkdir(parents=True, exist_ok=True)
        with open(MEMORY_LOG_PATH, "w", encoding="utf-8") as f:
            json.dump(exploration_history, f, indent=2)
        print(f"\n[explore_vision] Memory log saved → {MEMORY_LOG_PATH}")

        cases = []
        execution_report = None
        try:
            cases, cases_path = generate_test_cases(
                exploration_history,
                VISION_DIR / "vision_test_cases.json",
                run_id=RUN_ID,
            )
            cases.extend(behavior.completed)
            cases.extend(specified_cases)
            (VISION_DIR / "behavior_review.json").write_text(json.dumps(behavior.summary(), indent=2), encoding="utf-8")
            (VISION_DIR / "coverage.json").write_text(json.dumps(coverage.summary(), indent=2), encoding="utf-8")
            print(f"[explore_vision] Generated {len(cases)} test case(s) → {cases_path}")
            for case in cases:
                case.setdefault("preconditions", {"app_package": args.app_package, "app_activity": args.app_activity})
            Path(cases_path).write_text(json.dumps(cases, indent=2), encoding="utf-8")

            config = json.loads((VISION_DIR / "run_config.json").read_text(encoding="utf-8")) if (VISION_DIR / "run_config.json").is_file() else {}
            config["llm_calls"] = model_calls
            (VISION_DIR / "run_config.json").write_text(json.dumps(config, indent=2), encoding="utf-8")
            metadata = write_exploration_metadata(VISION_DIR, exploration_history, {
                "model": config.get("model"), "exploration_stop_reason": exploration_stop_reason,
                "exploration_complete": exploration_complete,
            })
            session = None
            if args.comparison:
                session = MobileRun("B", args.app or args.app_package, args.comparison,
                                    exploration_history, cases, metadata=metadata)
                session.run.setdefault("run_details", {})["exploration"] = {
                    "policy": exploration_policy, "behavior_profile": args.behavior_profile,
                    "functional_scenarios": behavior.summary(), "coverage": coverage.summary()}
                session.run["run_details"].setdefault("llm", {})["calls"] = model_calls
                session.save([])

            if args.execute_generated:
                from vision.vision_test_executor import execute_all

                execution_report = execute_all(
                    driver,
                    cases,
                    VISION_DIR / "test_execution",
                    args.app_package,
                    database_session=session,
                    app_activity=args.app_activity,
                )

            summary = write_run_summary(VISION_DIR, exploration_history, cases, execution_report)
            summary["functional_exploration"] = behavior.summary()
            summary["llm_calls"] = model_calls
            summary["exploration_policy"] = exploration_policy
            summary.update({k: metadata[k] for k in ("model", "exploration_stop_reason", "exploration_complete")})
            summary["exploration_error"] = exploration_error
            summary["exploration_completed_budget"] = bool(exploration_history and exploration_history[-1].get("step") == args.max_steps and not exploration_error)
            summary["exploration_status"] = "failed" if exploration_error else "profile_completed" if exploration_stop_reason == "functional_profile_complete" else (
                "budget_completed" if summary["exploration_completed_budget"] else "stopped_early")
            summary["coverage"] = coverage.summary()
            (VISION_DIR / "run_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
        except Exception as e:
            finalization_error = str(e)
            print(f"[explore_vision] Test generation/execution finalization failed: {e}")
        finally:
            driver.quit()
        print("[explore_vision] Done.")
        print(f"  Screenshots : {SCREENSHOTS_DIR}/")
        print(f"  JSON files  : {JSON_DIR}/")
        print(f"  Memory log  : {MEMORY_LOG_PATH}")

    return 1 if exploration_error or finalization_error else 0


if __name__ == "__main__":
    sys.exit(main())
