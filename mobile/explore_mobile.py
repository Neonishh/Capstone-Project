"""
explore_mobile.py - Mobile UI Exploration Pipeline

Usage:
  python explore_mobile.py
  python explore_mobile.py --app-package com.example.app --app-activity .MainActivity

Environment variables:
  STUB_LLM=true         - run without real LLM (used by dry_run.py's offline tests)
  MAX_STEPS=10          - exploration depth (default 10)
  APPIUM_HOST=localhost - Appium server host
  APPIUM_PORT=4723      - Appium server port
  LLM_PROVIDER=gemini   - openai | gemini
  GEMINI_API_KEY=...    - required when LLM_PROVIDER=gemini
  OPENAI_API_KEY=...    - required when LLM_PROVIDER=openai
"""

import argparse
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass  # python-dotenv not installed - fall back to shell-exported env vars

from src.view_hierarchy_parser import get_view_hierarchy, parse_elements, get_screen_meta
from src.mobile_preprocess import preprocess_elements, build_exploration_prompt, get_tried_targets
from src.memory_log import store_step, save_log
from src.llm_client import call_llm, parse_action, execute_action, LLM_PROVIDER
from src.test_generator import generate_test_cases

MAX_STEPS   = int(os.environ.get("MAX_STEPS", 10))
STUB_LLM    = os.environ.get("STUB_LLM", "false").lower() == "true"
APPIUM_HOST = os.environ.get("APPIUM_HOST", "localhost")
APPIUM_PORT = int(os.environ.get("APPIUM_PORT", 4723))

LOGS_DIR        = Path(__file__).parent / "logs"
SCREENSHOTS_DIR = LOGS_DIR / "screenshots"
MEMORY_LOG_PATH = str(LOGS_DIR / "mobile_memory_log.json")
TEST_CASES_PATH = str(LOGS_DIR / "mobile_test_cases.json")

DEFAULT_APP_PACKAGE  = "com.android.settings"
DEFAULT_APP_ACTIVITY = ".Settings"


def take_screenshot(driver, label: str) -> str:
    filename = f"{label}.png"
    full_path = SCREENSHOTS_DIR / filename
    try:
        driver.save_screenshot(str(full_path))
    except Exception as e:
        print(f"[explore_mobile] Screenshot failed ({label}): {e}")
    return f"logs/screenshots/{filename}"



def reset_device_state(app_package: str) -> None:
    """
    Runs before every session to guarantee a fresh, predictable starting
    point instead of resuming wherever the emulator was left last time.

    Without this, no_reset=True means Appium just brings whatever's already
    on screen to the foreground - which is how a run pointed at
    com.android.settings can end up resuming a half-finished Google account
    setup flow inside com.google.android.gm/.gms instead of actually
    launching Settings. This does automatically what we were doing by hand:
    force-stop and clear the Google account-setup packages, then force-stop
    the target app so it launches clean.

    Best-effort: failures here are logged but never abort the run, since a
    fresh emulator (or an app with no such flow pending) will just no-op.
    """
    print("[explore_mobile] Resetting device state before launch...")

    commands = [
        ["adb", "shell", "am", "force-stop", "com.google.android.gm"],
        ["adb", "shell", "am", "force-stop", "com.google.android.gms"],
        ["adb", "shell", "pm", "clear", "com.google.android.gms"],
        ["adb", "shell", "am", "force-stop", app_package],
    ]
    for cmd in commands:
        try:
            subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=15)
        except FileNotFoundError:
            print("[explore_mobile] 'adb' not found on PATH - skipping device reset.")
            return
        except subprocess.CalledProcessError as e:
            # Non-fatal - e.g. "pm clear" fails harmlessly if GMS wasn't
            # holding any pending state, or a package simply isn't running.
            print(f"[explore_mobile] Reset step failed (non-fatal): {' '.join(cmd)} -> {e.stderr.strip() if e.stderr else e}")
        except subprocess.TimeoutExpired:
            print(f"[explore_mobile] Reset step timed out (non-fatal): {' '.join(cmd)}")

    print("[explore_mobile] Device state reset complete.\n")


def build_driver(app_package: str, app_activity: str):
    from appium import webdriver
    from appium.options.android import UiAutomator2Options

    options = UiAutomator2Options()

    options.platform_name = "Android"
    options.automation_name = "UiAutomator2"
    options.app_package = app_package
    options.app_activity = app_activity
    options.no_reset = True
    options.auto_grant_permissions = True
    # Default UiAutomator2 session timeout is only 60s of inactivity - any
    # pause longer than that (slow LLM call, laptop sleep, network stall)
    # silently kills the whole Appium session, and every step after that
    # fails with "session is either terminated or not started". Bump this
    # generously; it costs nothing while the loop is actively running.
    options.new_command_timeout = 300

    appium_url = f"http://{APPIUM_HOST}:{APPIUM_PORT}"
    print(f"[explore_mobile] Connecting to Appium at {appium_url}...")

    driver = webdriver.Remote(appium_url, options=options)

    print("[explore_mobile] Connected.")
    return driver

def main():
    parser = argparse.ArgumentParser(description="Mobile UI Exploration Pipeline")
    parser.add_argument("--app-package",  default=DEFAULT_APP_PACKAGE)
    parser.add_argument("--app-activity", default=DEFAULT_APP_ACTIVITY)
    args = parser.parse_args()

    print("=" * 55)
    print(" Mobile Exploration Pipeline - Project 101 (PES University)")
    print(f"  App      : {args.app_package}/{args.app_activity}")
    print(f"  Max steps: {MAX_STEPS}")
    print(f"  LLM mode : {'STUB (no API call)' if STUB_LLM else 'LIVE'}")
    print(f"  Provider : {LLM_PROVIDER if not STUB_LLM else '-'}")
    print("=" * 55)

    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)

    reset_device_state(args.app_package)
    driver = build_driver(args.app_package, args.app_activity)
    memory_log = []
    step_counter = 0

    try:
        time.sleep(2)
        meta = get_screen_meta(driver)
        print(f"[explore_mobile] App launched: {meta['title']} ({meta['url']})\n")

        while step_counter < MAX_STEPS:
            print(f"-------- Step {step_counter + 1} / {MAX_STEPS} --------")

            from_meta = get_screen_meta(driver)

            try:
                xml_source = get_view_hierarchy(driver)
                raw_elements = parse_elements(xml_source)
                print(f"[explore_mobile] Extracted {len(raw_elements)} raw elements")
            except Exception as e:
                print(f"[explore_mobile] parse_elements() failed: {e} - skipping step")
                step_counter += 1
                continue

            elements = preprocess_elements(raw_elements)
            print(f"[explore_mobile] After preprocessing: {len(elements)} elements")

            if not elements:
                print("[explore_mobile] No interactable elements found - ending exploration")
                break

            tag_short = elements[0].get("tag", "screen").split(".")[-1]
            screenshot_before = take_screenshot(driver, f"{step_counter + 1}_before_{tag_short}")

            # current_url lets the prompt tell the LLM what's already been
            # tried on THIS screen, so it explores sideways (back + a
            # sibling) instead of repeating itself or bailing with "done".
            prompt = build_exploration_prompt(elements, memory_log, current_url=from_meta["url"])

            try:
                llm_response = call_llm(prompt)
            except Exception as e:
                print(f"[explore_mobile] call_llm() error: {e}")
                store_step(memory_log, {
                    "step": step_counter,
                    "from_url": from_meta["url"],
                    "from_title": from_meta["title"],
                    "action": "error",
                    "target": "LLM_FAILURE",
                    "target_element_details": None,
                    "to_url": from_meta["url"],
                    "to_title": from_meta["title"],
                    "screenshot_before": screenshot_before,
                    "screenshot_after": screenshot_before,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "error": str(e),
                })
                step_counter += 1
                continue

            action = parse_action(llm_response)
            print(f"[explore_mobile] LLM action -> {action['action']} | reason: {action.get('reason', '')}")

            # Enforcement, not just a prompt suggestion: some models
            # (especially smaller local ones) don't reliably follow the
            # "don't repeat an already-tried element" instruction in the
            # prompt. If it proposes tapping/typing something this screen
            # has already seen, force 'back' instead of trusting it -
            # otherwise it can sit there retapping a dead element until
            # loop-detection eventually kills the whole run.
            if action["action"] in ("tap", "type"):
                already_tried = get_tried_targets(memory_log, from_meta["url"])
                proposed_target = action.get("resource_id") or ""
                if not proposed_target and action.get("elementId") is not None:
                    match = next((el for el in elements if el["elementId"] == action["elementId"]), None)
                    proposed_target = (match or {}).get("resource_id", "") or (match or {}).get("tag", "")
                if proposed_target and proposed_target in already_tried:
                    print(
                        f"[explore_mobile] Overriding LLM: '{proposed_target}' was already "
                        f"tried on this screen - forcing 'back' instead of repeating it."
                    )
                    action = {
                        "action": "back",
                        "elementId": None,
                        "resource_id": "",
                        "value": "",
                        "reason": "auto-override: repeated an already-tried element",
                    }

            if action["action"] == "done":
                print("[explore_mobile] LLM returned 'done' - exploration complete")
                break

            execute_error = None
            try:
                execute_action(driver, action, elements)
                time.sleep(1)
            except Exception as e:
                print(f"[explore_mobile] execute_action failed: {e}")
                execute_error = str(e)

            to_meta = get_screen_meta(driver)
            screenshot_after = take_screenshot(driver, f"{step_counter + 1}_after_{action['action']}")

            target_el = next(
                (el for el in elements if el["elementId"] == action.get("elementId")), None
            )

            step_data = {
                "step": step_counter,
                "from_url": from_meta["url"],
                "from_title": from_meta["title"],
                "action": action["action"],
                "target": (
                    "BACK" if action["action"] == "back" else
                    (
                        (target_el.get("resource_id") or target_el.get("tag", "unknown"))
                        if target_el else (action.get("resource_id") or "unknown")
                    )
                ),
                "target_element_details": target_el,
                "to_url": to_meta["url"],
                "to_title": to_meta["title"],
                "screenshot_before": screenshot_before,
                "screenshot_after": screenshot_after,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            }
            if execute_error:
                step_data["error"] = execute_error
            if action.get("value"):
                step_data["value"] = action["value"]

            store_step(memory_log, step_data)
            print(f"[explore_mobile] Step {step_counter + 1} logged | {from_meta['url']} -> {to_meta['url']}")

            if len(memory_log) >= 3:
                last3 = memory_log[-3:]
                same_screen = len({s["to_url"] for s in last3}) == 1
                same_target = len({s["target"] for s in last3}) == 1
                # Only a real loop if BOTH the screen AND the exact element
                # being acted on repeat 3 times in a row. Checking to_url
                # alone false-triggers on legitimate progress: typing into
                # 3 different fields on the same screen never navigates
                # anywhere, so to_url is identical for all 3 steps even
                # though real, distinct work is happening.
                if same_screen and same_target:
                    print("[explore_mobile] Loop detected - ending exploration")
                    break

            step_counter += 1

        print(f"\n[explore_mobile] Exploration complete - {len(memory_log)} step(s) logged")
        save_log(memory_log, MEMORY_LOG_PATH)

        if memory_log:
            print("\n[explore_mobile] Generating test cases...")
            generate_test_cases(memory_log, TEST_CASES_PATH)

    except Exception as fatal:
        print(f"\n[explore_mobile] FATAL ERROR: {fatal}")
        import traceback
        traceback.print_exc()
        if memory_log:
            save_log(memory_log, MEMORY_LOG_PATH)

    finally:
        try:
            driver.quit()
        except Exception:
            pass
        print("\n[explore_mobile] Done.")
        print(f"  - {MEMORY_LOG_PATH}")
        print(f"  - {TEST_CASES_PATH}")
        print(f"  - {SCREENSHOTS_DIR}/")


if __name__ == "__main__":
    main()