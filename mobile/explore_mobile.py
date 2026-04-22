"""
explore_mobile.py - Mobile UI Exploration Pipeline

Usage:
  python explore_mobile.py
  python explore_mobile.py --app-package com.example.app --app-activity .MainActivity

Environment variables:
  STUB_LLM=true         - run without real LLM
  MAX_STEPS=10          - exploration depth (default 10)
  APPIUM_HOST=localhost - Appium server host
  APPIUM_PORT=4723      - Appium server port
  OPENAI_API_KEY=...    - required when STUB_LLM is not set
"""

import argparse
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from src.view_hierarchy_parser import get_view_hierarchy, parse_elements, get_screen_meta
from src.mobile_preprocess import preprocess_elements, build_exploration_prompt
from src.memory_log import store_step, save_log
from src.llm_client import call_llm, parse_action, execute_action
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
    options.app_wait_activity = "*"

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
    print("=" * 55)

    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)

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

            prompt = build_exploration_prompt(elements, memory_log)

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
                    (target_el.get("resource_id") or target_el.get("tag", "unknown"))
                    if target_el else (action.get("resource_id") or "unknown")
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
                last3 = [s["to_url"] for s in memory_log[-3:]]
                if len(set(last3)) == 1:
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
