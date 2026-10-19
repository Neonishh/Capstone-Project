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
from vision.ocr_extractor import extract_text
from vision.vision_merger import merge
from vision.llm_reasoner import decide_next_action
from vision.accessibility_extractor import extract_accessibility
from vision.coordinate_mapper import map_bbox_center, annotate_tap
from vision.action_verification import verify_action
from vision.test_case_generator import generate_test_cases, write_run_summary
from src.database_storage import MobileRun, add_database_arguments
from vision.app_state import launch_start
from vision.quality import Coverage, screen_key, requirement_cases

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
    options.app_wait_activity      = "*"

    appium_url = f"http://{APPIUM_HOST}:{APPIUM_PORT}"
    print(f"[explore_vision] Connecting to Appium at {appium_url}...")
    driver = webdriver.Remote(appium_url, options=options)
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

    if action_type == "back":
        driver.back()
        time.sleep(0.5)
        return {"status": "executed", "method": "back"}

    if action_type == "swipe":
        _do_swipe(driver)
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

    elif action_type == "type":
        driver.tap([(cx, cy)])
        time.sleep(0.3)
        value = action.get("value", "")
        if action.get("clear"):
            driver.switch_to.active_element.clear()
        if value:
            driver.execute_script("mobile: type", {"text": value})
    else:
        return {"status": "skipped", "reason": f"unsupported_action:{action_type}"}

    debug_dir = Path(action.get("_debug_dir") or DEBUG_DIR)
    debug_path = annotate_tap(
        screenshot_path,
        bbox,
        (shot_x, shot_y),
        f"{action_type}: {action.get('target', '')}",
        debug_dir / f"step_{action.get('_step', 'unknown'):02d}_tap.png",
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


def _do_swipe(driver) -> None:
    size = driver.get_window_size()
    w, h = size["width"], size["height"]
    driver.swipe(
        start_x=w // 2, start_y=int(h * 0.7),
        end_x=w // 2,   end_y=int(h * 0.3),
        duration=500,
    )


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
    parser.add_argument("--requirements", help="JSON requirement scenarios with explicit oracles")
    add_database_arguments(parser)
    args = parser.parse_args()
    if args.max_steps < 1:
        parser.error("--max-steps must be positive")
    specified_cases = requirement_cases(args.requirements) if args.requirements else []
    coverage = Coverage()

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
            "model": os.environ.get("GEMINI_MODEL") if os.environ.get("LLM_PROVIDER") == "gemini" else None,
        }, indent=2), encoding="utf-8")
        for step in range(1, args.max_steps + 1):
            print(f"\n======== Vision Step {step} / {args.max_steps} ========")

            # ── Module 1: Screenshot ──────────────────────────────────────
            screenshot_path = capture_screenshot(driver, str(SCREENSHOTS_DIR), step)

            # ── Module 2: YOLO ────────────────────────────────────────────
            try:
                yolo_results = detect_ui_components(screenshot_path)
            except Exception as e:
                print(f"[explore_vision] YOLO failed: {e}")
                yolo_results = []

            # ── Module 3: OCR ─────────────────────────────────────────────
            try:
                ocr_results = extract_text(screenshot_path)
            except Exception as e:
                print(f"[explore_vision] OCR failed: {e}")
                ocr_results = []

            # Appium's hierarchy supplies exact labels and bounds even when
            # OCR is unavailable and YOLO has no UI-trained detections.
            try:
                accessibility_results = extract_accessibility(driver)
            except Exception as e:
                print(f"[explore_vision] Accessibility extraction failed: {e}")
                accessibility_results = []

            # ── Module 4: Merge ───────────────────────────────────────────
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
                action = decide_next_action(screen_data, exploration_history)
            except Exception as e:
                print(f"[explore_vision] LLM failed: {e}")
                (VISION_DIR / "llm_error.json").write_text(json.dumps({
                    "step": step, "error": str(e), "type": type(e).__name__,
                }, indent=2), encoding="utf-8")
                raise RuntimeError("Exploration stopped after LLM failure; no fallback tests generated") from e

            current_screen_key = screen_key(accessibility_results, driver.current_activity)
            action = coverage.choose(current_screen_key, action, screen_data.get("elements", []))

            log_entry = {
                "step":       step,
                "screen_key": current_screen_key,
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
            }
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
                    time.sleep(1.5)   # let screen settle
                    screenshot_after = capture_screenshot(
                        driver, str(SCREENSHOTS_DIR), step, suffix="after"
                    )
                    after_accessibility = extract_accessibility(driver)
                    activity_after = driver.current_activity
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
                        "screen_key_after": screen_key(after_accessibility, activity_after),
                        "controls_after": [{k: el.get(k) for k in ("text", "resource_id", "checked", "checkable")} for el in after_accessibility],
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
                    if selected and selected.get("checkable") and execution.get("status") == "executed":
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
                except Exception as e:
                    print(f"[explore_vision] Execute failed: {e} — continuing")
                    log_entry["execution"] = {"status": "error", "error": str(e)}
                    if selected and selected.get("checkable"):
                        break

    except Exception as fatal:
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
            cases.extend(specified_cases)
            (VISION_DIR / "coverage.json").write_text(json.dumps(coverage.summary(), indent=2), encoding="utf-8")
            print(f"[explore_vision] Generated {len(cases)} test case(s) → {cases_path}")
            for case in cases:
                case.setdefault("preconditions", {"app_package": args.app_package, "app_activity": args.app_activity})
            Path(cases_path).write_text(json.dumps(cases, indent=2), encoding="utf-8")

            session = None
            if args.comparison:
                session = MobileRun("B", args.app or args.app_package, args.comparison,
                                    exploration_history, cases)
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

            write_run_summary(VISION_DIR, exploration_history, cases, execution_report)
        except Exception as e:
            print(f"[explore_vision] Test generation/execution finalization failed: {e}")
        finally:
            driver.quit()
        print("[explore_vision] Done.")
        print(f"  Screenshots : {SCREENSHOTS_DIR}/")
        print(f"  JSON files  : {JSON_DIR}/")
        print(f"  Memory log  : {MEMORY_LOG_PATH}")


if __name__ == "__main__":
    main()
