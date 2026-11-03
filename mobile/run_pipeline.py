"""
run_pipeline.py
Full one-command pipeline:
  Explore → GenerateTestCases → GenerateScript → ExecuteTests → Report → SupabaseUpload

Usage:
  python run_pipeline.py --app contacts --comparison mobile15-gpt4omini-40-v1-r1 \
      --app-package org.fossify.contacts --app-activity .activities.SplashActivity.Green

  # Skip exploration (use existing memory log):
  python run_pipeline.py --app contacts --comparison mobile15-gpt4omini-40-v1-r1 \
      --app-package org.fossify.contacts --app-activity .activities.SplashActivity.Green \
      --skip-exploration

Environment variables:
  LLM_PROVIDER=openai, OPENAI_API_KEY, OPENAI_MODEL=gpt-4o-mini
  MAX_STEPS=40
  APP_PACKAGE, APP_ACTIVITY  (can also be passed as args)
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DB_UPLOAD_ENABLED=true
  PIPELINE_TIMEOUT_SECONDS=1800
"""

import argparse
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'database'))

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass

from src.view_hierarchy_parser import get_view_hierarchy, parse_elements, get_screen_meta
from src.mobile_preprocess import preprocess_elements, build_exploration_prompt, get_tried_targets
from src.memory_log import store_step, save_log, load_log
from src.llm_client import call_llm, parse_action, execute_action, LLM_PROVIDER
from src.test_generator import generate_test_cases
from src.script_generator import generate_script
from src.test_executor import execute_test_cases
from src.report_generator import generate_report
from src.database_storage import (
    MobileRun, add_database_arguments,
    write_exploration_metadata, read_exploration_metadata,
)

# Words that indicate a dismissive/destructive action — tap these LAST
_DISMISS_KEYWORDS = {
    "close", "cancel", "dismiss", "skip", "exit", "quit", "no", "deny",
    "decline", "reject", "not now", "maybe later", "later", "never",
    "don't allow", "dont allow", "do not allow", "discard", "delete",
    "remove", "clear", "reset", "x",
}

def _is_dismiss_element(el: dict) -> bool:
    """Returns True if this element looks like a close/cancel/dismiss button."""
    text = (el.get("text") or "").lower().strip()
    desc = (el.get("content_desc") or "").lower().strip()
    rid  = (el.get("resource_id") or "").lower()
    combined = f"{text} {desc} {rid}"
    return any(kw in combined for kw in _DISMISS_KEYWORDS)


def _has_non_dismiss_untried(elements: list, tried: set) -> bool:
    """Returns True if there are untried elements that are NOT dismiss actions."""
    for el in elements:
        target = el.get("resource_id") or el.get("tag", "")
        if target not in tried and not _is_dismiss_element(el):
            return True
    return False

LOGS_DIR        = Path(__file__).parent / "logs"
SCREENSHOTS_DIR = LOGS_DIR / "screenshots"

MEMORY_LOG_PATH     = str(LOGS_DIR / "mobile_memory_log.json")
TEST_CASES_PATH     = str(LOGS_DIR / "mobile_test_cases.json")
SCRIPT_PATH         = str(LOGS_DIR / "generated_test_script.py")
REPORT_PATH         = str(LOGS_DIR / "execution_report.json")

APPIUM_HOST      = os.environ.get("APPIUM_HOST", "localhost")
APPIUM_PORT      = int(os.environ.get("APPIUM_PORT", 4723))
MAX_STEPS        = int(os.environ.get("MAX_STEPS", 40))
STUB_LLM         = os.environ.get("STUB_LLM", "false").lower() == "true"
PIPELINE_TIMEOUT = int(os.environ.get("PIPELINE_TIMEOUT_SECONDS", 1800))


# ── Appium driver ─────────────────────────────────────────────────────────────

def _build_exploration_driver(app_package: str, app_activity: str):
    from appium import webdriver
    from appium.options.android import UiAutomator2Options
    options = UiAutomator2Options()
    options.platform_name          = "Android"
    options.app_package            = app_package
    options.app_activity           = app_activity
    options.no_reset               = True
    options.auto_grant_permissions = True
    options.new_command_timeout    = 300
    appium_url = f"http://{APPIUM_HOST}:{APPIUM_PORT}"
    print(f"[pipeline] Connecting to Appium at {appium_url}...")
    driver = webdriver.Remote(appium_url, options=options)
    print("[pipeline] Connected.")
    return driver


def _build_execution_driver(app_package: str, app_activity: str):
    from appium import webdriver
    from appium.options.android import UiAutomator2Options
    options = UiAutomator2Options()
    options.platform_name          = "Android"
    options.app_package            = app_package
    options.app_activity           = app_activity
    options.no_reset               = False
    options.auto_grant_permissions = True
    options.new_command_timeout    = 300
    options.app_wait_activity      = "*"
    options.app_wait_duration      = 10000
    appium_url = f"http://{APPIUM_HOST}:{APPIUM_PORT}"
    driver = webdriver.Remote(appium_url, options=options)
    return driver


# ── Exploration stage ─────────────────────────────────────────────────────────

def _take_screenshot(driver, label: str) -> str:
    filename = f"{label}.png"
    full_path = SCREENSHOTS_DIR / filename
    try:
        driver.save_screenshot(str(full_path))
    except Exception as e:
        print(f"[pipeline] Screenshot failed ({label}): {e}")
    return f"logs/screenshots/{filename}"


def _reset_app(app_package: str) -> None:
    print("[pipeline] Force-stopping app before exploration...")
    try:
        subprocess.run(["adb", "shell", "am", "force-stop", app_package],
                       check=True, capture_output=True, timeout=15)
    except Exception as e:
        print(f"[pipeline] Reset step failed (non-fatal): {e}")


def run_exploration(app_package: str, app_activity: str) -> list:
    """Runs the full exploration loop and returns the memory log."""
    SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)

    _reset_app(app_package)
    driver = _build_exploration_driver(app_package, app_activity)
    memory_log = []
    stop_reason = "step_budget"
    exploration_complete = False
    had_errors = False
    step_counter = 0

    try:
        time.sleep(3)  # wait longer for first-launch screens to fully render
        meta = get_screen_meta(driver)
        print(f"[pipeline] App launched: {meta['title']} ({meta['url']})\n")

        while step_counter < MAX_STEPS:
            print(f"  -- Step {step_counter + 1} / {MAX_STEPS} --")
            from_meta = get_screen_meta(driver)

            # Stay within target app
            if app_package not in from_meta["url"]:
                print(f"[pipeline] Left target app — pressing back")
                try:
                    execute_action(driver, {"action": "back", "elementId": None,
                                            "resource_id": "", "value": ""}, [])
                    time.sleep(1)
                    from_meta = get_screen_meta(driver)
                    if app_package not in from_meta["url"]:
                        stop_reason = "left_app"
                        break
                except Exception:
                    stop_reason = "left_app"
                    break

            try:
                xml_source = get_view_hierarchy(driver)
                raw_elements = parse_elements(xml_source)
            except Exception as e:
                print(f"[pipeline] parse_elements failed: {e} — skipping")
                step_counter += 1
                continue

            elements = preprocess_elements(raw_elements)
            print(f"[pipeline] {len(raw_elements)} raw → {len(elements)} elements")

            if not elements:
                stop_reason = "no_interactive_controls"
                break

            tag_short = elements[0].get("tag", "screen").split(".")[-1]
            screenshot_before = _take_screenshot(driver, f"{step_counter+1}_before_{tag_short}")
            prompt = build_exploration_prompt(elements, memory_log, current_url=from_meta["url"])

            try:
                llm_response = call_llm(prompt)
            except Exception as e:
                had_errors = True
                stop_reason = "rate_limit" if "429" in str(e) else "llm_error"
                print(f"[pipeline] LLM error: {e}")
                store_step(memory_log, {
                    "step": step_counter, "from_url": from_meta["url"],
                    "from_title": from_meta["title"], "action": "error",
                    "target": "LLM_FAILURE", "target_element_details": None,
                    "to_url": from_meta["url"], "to_title": from_meta["title"],
                    "screenshot_before": screenshot_before,
                    "screenshot_after": screenshot_before,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "error": str(e),
                })
                step_counter += 1
                continue

            action = parse_action(llm_response)
            print(f"[pipeline] LLM → {action['action']} | {action.get('reason', '')}")

            if action["action"] in ("tap", "type"):
                already_tried = get_tried_targets(memory_log, from_meta["url"])
                proposed = action.get("resource_id") or ""
                if not proposed and action.get("elementId") is not None:
                    match = next((el for el in elements if el["elementId"] == action["elementId"]), None)
                    proposed = (match or {}).get("resource_id", "") or (match or {}).get("tag", "")
                if proposed and proposed in already_tried:
                    action = {"action": "back", "elementId": None,
                              "resource_id": "", "value": "",
                              "reason": "auto-override: repeated element"}

            # Never press back on the first 3 steps — the app just launched
            # and there is nothing to go back to. Back on step 0/1/2 exits
            # the app entirely and the whole exploration run is wasted.
            if action["action"] == "back" and step_counter < 3:
                print(f"[pipeline] Blocked 'back' on step {step_counter+1} (too early) — forcing swipe instead")
                action = {"action": "swipe", "elementId": None,
                          "resource_id": "", "value": "",
                          "reason": "auto-override: back blocked on early step"}

            # If the LLM chose a dismiss/close/cancel element but there are
            # still non-dismiss untried elements on screen, override it and
            # pick the first untried non-dismiss element instead.
            if action["action"] == "tap" and action.get("elementId") is not None:
                chosen_el = next((el for el in elements if el["elementId"] == action["elementId"]), None)
                already_tried = get_tried_targets(memory_log, from_meta["url"])
                if chosen_el and _is_dismiss_element(chosen_el) and \
                        _has_non_dismiss_untried(elements, already_tried):
                    # Find the first untried non-dismiss element
                    override = next(
                        (el for el in elements
                         if (el.get("resource_id") or el.get("tag", "")) not in already_tried
                         and not _is_dismiss_element(el)),
                        None,
                    )
                    if override:
                        print(
                            f"[pipeline] Blocked dismiss tap on '{chosen_el.get('text') or chosen_el.get('resource_id')}' "
                            f"— non-dismiss elements still untried. Redirecting to: "
                            f"'{override.get('text') or override.get('resource_id') or override.get('tag')}'"
                        )
                        action = {
                            "action": "tap",
                            "elementId": override["elementId"],
                            "resource_id": override.get("resource_id", ""),
                            "value": "",
                            "reason": "auto-override: explore before dismissing",
                        }

            if action["action"] == "done":
                stop_reason = "agent_done"
                exploration_complete = not had_errors and not STUB_LLM
                break

            execute_error = None
            try:
                execute_action(driver, action, elements)
                time.sleep(1)
            except Exception as e:
                print(f"[pipeline] execute_action failed: {e}")
                execute_error = str(e)
                had_errors = True

            to_meta = get_screen_meta(driver)
            screenshot_after = _take_screenshot(driver, f"{step_counter+1}_after_{action['action']}")

            # If the app exited (home screen / different package), relaunch it
            if app_package not in to_meta["url"]:
                print(f"[pipeline] App exited to {to_meta['url']} — relaunching {app_package}")
                try:
                    driver.activate_app(app_package)
                    time.sleep(2)
                    to_meta = get_screen_meta(driver)
                    print(f"[pipeline] Relaunched — now on {to_meta['url']}")
                except Exception as relaunch_err:
                    print(f"[pipeline] Relaunch failed: {relaunch_err} — ending exploration")
                    stop_reason = "left_app"
                    break
            target_el = next((el for el in elements if el["elementId"] == action.get("elementId")), None)

            step_data = {
                "step": step_counter,
                "from_url": from_meta["url"], "from_title": from_meta["title"],
                "action": action["action"],
                "target": ("BACK" if action["action"] == "back" else
                           ((target_el.get("resource_id") or target_el.get("tag", "unknown"))
                            if target_el else (action.get("resource_id") or "unknown"))),
                "target_element_details": target_el,
                "to_url": to_meta["url"], "to_title": to_meta["title"],
                "screenshot_before": screenshot_before, "screenshot_after": screenshot_after,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            if execute_error:
                step_data["error"] = execute_error
            if action.get("value"):
                step_data["value"] = action["value"]

            store_step(memory_log, step_data)
            print(f"[pipeline] Step {step_counter+1} logged | {from_meta['url']} → {to_meta['url']}")

            if len(memory_log) >= 3:
                last3 = memory_log[-3:]
                if len({s["to_url"] for s in last3}) == 1 and len({s["target"] for s in last3}) == 1:
                    stop_reason = "loop_detected"
                    break

            step_counter += 1

    except Exception as fatal:
        stop_reason = "error"
        print(f"[pipeline] FATAL during exploration: {fatal}")
        import traceback
        traceback.print_exc()
    finally:
        save_log(memory_log, MEMORY_LOG_PATH)
        defaults = {"openai": "gpt-4o-mini", "gemini": "gemini-2.5-flash",
                    "groq": "llama-3.3-70b-versatile", "ollama": "llama3.1"}
        # Compute before writing so the correct value is saved
        exploration_complete = (
            stop_reason in ("agent_done", "step_budget") and not had_errors and not STUB_LLM
        )
        write_exploration_metadata(LOGS_DIR, memory_log, {
            "model": "stub" if STUB_LLM else os.environ.get(
                LLM_PROVIDER.upper() + "_MODEL", defaults.get(LLM_PROVIDER, "unknown")),
            "exploration_stop_reason": "stub" if STUB_LLM else stop_reason,
            "exploration_complete": exploration_complete,
        })
        try:
            driver.quit()
        except Exception:
            pass
        print(f"[pipeline] Exploration done — {len(memory_log)} steps, stop: {stop_reason}, complete: {exploration_complete}")

    return memory_log


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Mobile Full Pipeline — Architecture A")
    parser.add_argument("--app-package",  default=os.environ.get("APP_PACKAGE", "com.android.settings"))
    parser.add_argument("--app-activity", default=os.environ.get("APP_ACTIVITY", ".Settings"))
    parser.add_argument("--skip-exploration", action="store_true",
                        help="Skip exploration and use existing memory log")
    parser.add_argument("--skip-execution", action="store_true",
                        help="Skip test execution (generate script only)")
    add_database_arguments(parser)
    args = parser.parse_args()

    app_package  = args.app_package
    app_activity = args.app_activity
    app_id       = args.app or os.environ.get("APP_ID") or app_package.split(".")[-1]
    comparison_id = args.comparison or os.environ.get("COMPARISON_ID", "mobile15-gpt4omini-40-v1-r1")

    pipeline_start = time.time()
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)

    print("=" * 55)
    print(" Mobile Pipeline — Architecture A (PES University 101)")
    print(f"  App      : {app_package}")
    print(f"  App ID   : {app_id}")
    print(f"  Compare  : {comparison_id}")
    print(f"  Steps    : {MAX_STEPS}")
    print(f"  Timeout  : {PIPELINE_TIMEOUT}s")
    print(f"  Provider : {LLM_PROVIDER}")
    print("=" * 55)

    # ── Stage 1: Explore ──────────────────────────────────────────────────────
    if args.skip_exploration:
        print("\n[pipeline] Stage 1: Loading existing memory log...")
        memory_log = load_log(MEMORY_LOG_PATH)
        if not memory_log:
            print("[pipeline] ERROR: No memory log found. Remove --skip-exploration to run exploration.")
            sys.exit(1)
        print(f"[pipeline] Loaded {len(memory_log)} steps.")
    else:
        print("\n[pipeline] Stage 1: Exploring app...")
        memory_log = run_exploration(app_package, app_activity)
        if not memory_log:
            print("[pipeline] Exploration produced no steps. Exiting.")
            sys.exit(1)

    exploration_meta = read_exploration_metadata(LOGS_DIR, memory_log)

    # ── Stage 2: Generate test cases ──────────────────────────────────────────
    print("\n[pipeline] Stage 2: Generating test cases via LLM...")
    test_cases = generate_test_cases(memory_log, TEST_CASES_PATH)
    if not test_cases:
        print("[pipeline] No test cases generated. Exiting.")
        sys.exit(1)

    # ── Stage 3: Generate script ───────────────────────────────────────────────
    print("\n[pipeline] Stage 3: Generating Appium script...")
    generate_script(test_cases, SCRIPT_PATH, app_package=app_package, app_activity=app_activity)

    if args.skip_execution:
        print(f"\n[pipeline] --skip-execution set. Script at: {SCRIPT_PATH}")
        return

    # Initialise Supabase run record
    mobile_run = None
    if args.comparison or os.environ.get("DB_UPLOAD_ENABLED") == "true":
        mobile_run = MobileRun(
            architecture="A", app_id=app_id, comparison_id=comparison_id,
            memory_log=memory_log, test_cases=test_cases, metadata=exploration_meta,
        )
        print(f"\n[pipeline] Run ID: {mobile_run.run['run_id']}")

    # ── Stage 4: Execute test cases ────────────────────────────────────────────
    print("\n[pipeline] Stage 4: Executing test cases on device...")
    results = []
    for i, tc in enumerate(test_cases):
        elapsed = time.time() - pipeline_start
        if PIPELINE_TIMEOUT - elapsed < 30:
            print(f"[pipeline] Time budget exhausted ({elapsed:.0f}s) — stopping")
            break

        tc_id = tc.get("test_case_id") or tc.get("id", f"TC{i+1:03d}")
        print(f"\n[pipeline] Fresh launch for {tc_id} ({elapsed:.0f}s elapsed)...")
        driver = _build_execution_driver(app_package, app_activity)
        driver.implicitly_wait(5)
        time.sleep(3)
        try:
            tc_results = execute_test_cases([tc], driver, str(SCREENSHOTS_DIR))
            results.extend(tc_results)
        finally:
            try:
                driver.quit()
            except Exception:
                pass

    total_elapsed = round(time.time() - pipeline_start, 1)

    # ── Stage 5: Report ────────────────────────────────────────────────────────
    print("\n[pipeline] Stage 5: Generating execution report...")
    generate_report(results, REPORT_PATH)

    print("\n[pipeline] Pipeline complete.")
    print(f"  Memory log : {MEMORY_LOG_PATH}")
    print(f"  Test cases : {TEST_CASES_PATH}")
    print(f"  Script     : {SCRIPT_PATH}")
    print(f"  Report     : {REPORT_PATH}")
    print(f"  Total time : {total_elapsed}s / {PIPELINE_TIMEOUT}s")

    # ── Stage 6: Upload to Supabase ────────────────────────────────────────────
    if mobile_run is not None:
        print("\n[pipeline] Stage 6: Uploading to Supabase...")
        mobile_run.save(results, finished=len(results) == len(test_cases))
    else:
        print("\n[pipeline] Skipping Supabase upload (no --comparison and DB_UPLOAD_ENABLED not set).")


if __name__ == "__main__":
    main()
