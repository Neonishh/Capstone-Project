"""
run_pipeline.py
Full pipeline runner:
  JSONLogReader → TestCaseGenerator → ScriptGenerator → TestExecutor → ReportGenerator

Usage:
  python run_pipeline.py                          # uses existing memory log
  python run_pipeline.py --skip-exploration       # same as above
  python run_pipeline.py --log-path path/to/log.json

Environment variables (same as explore_mobile.py):
  LLM_PROVIDER, GROQ_API_KEY, GEMINI_API_KEY, etc.
  APP_PACKAGE, APP_ACTIVITY  — app to run tests against
"""

import argparse
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass

from src.memory_log import load_log
from src.test_generator import generate_test_cases
from src.script_generator import generate_script
from src.test_executor import execute_test_cases
from src.report_generator import generate_report

LOGS_DIR        = Path(__file__).parent / "logs"
SCREENSHOTS_DIR = LOGS_DIR / "screenshots"

DEFAULT_LOG_PATH        = str(LOGS_DIR / "mobile_memory_log.json")
DEFAULT_TEST_CASES_PATH = str(LOGS_DIR / "mobile_test_cases.json")
DEFAULT_SCRIPT_PATH     = str(LOGS_DIR / "generated_test_script.py")
DEFAULT_REPORT_PATH     = str(LOGS_DIR / "execution_report.json")

APP_PACKAGE  = os.environ.get("APP_PACKAGE",  "com.android.settings")
APP_ACTIVITY = os.environ.get("APP_ACTIVITY", ".Settings")
APPIUM_HOST  = os.environ.get("APPIUM_HOST",  "localhost")
APPIUM_PORT  = int(os.environ.get("APPIUM_PORT", 4723))


def build_driver():
    from appium import webdriver
    from appium.options.android import UiAutomator2Options

    options = UiAutomator2Options()
    options.platform_name          = "Android"
    options.app_package            = APP_PACKAGE
    options.app_activity           = APP_ACTIVITY
    options.no_reset               = False
    options.auto_grant_permissions = True
    options.new_command_timeout    = 300
    options.app_wait_activity      = "*"
    options.app_wait_duration      = 10000

    appium_url = f"http://{APPIUM_HOST}:{APPIUM_PORT}"
    print(f"[pipeline] Connecting to Appium at {appium_url}...")
    driver = webdriver.Remote(appium_url, options=options)
    print("[pipeline] Connected.")
    return driver


def main():
    parser = argparse.ArgumentParser(description="Mobile Test Pipeline Runner")
    parser.add_argument("--log-path", default=DEFAULT_LOG_PATH,
                        help="Path to mobile_memory_log.json")
    parser.add_argument("--skip-execution", action="store_true",
                        help="Generate script only, don't execute tests")
    args = parser.parse_args()

    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)

    # ── Stage 1: Read memory log ──────────────────────────────────────────────
    print("\n[pipeline] Stage 1: Reading exploration log...")
    memory_log = load_log(args.log_path)
    if not memory_log:
        print(f"[pipeline] ERROR: No memory log found at {args.log_path}")
        print("[pipeline] Run explore_mobile.py first to generate the log.")
        sys.exit(1)
    print(f"[pipeline] Loaded {len(memory_log)} steps from {args.log_path}")

    # ── Stage 2: Generate test cases via LLM ──────────────────────────────────
    print("\n[pipeline] Stage 2: Generating test cases via LLM...")
    test_cases = generate_test_cases(memory_log, DEFAULT_TEST_CASES_PATH)
    if not test_cases:
        print("[pipeline] No test cases generated. Exiting.")
        sys.exit(1)

    # ── Stage 3: Generate executable script ───────────────────────────────────
    print("\n[pipeline] Stage 3: Generating Appium script...")
    generate_script(
        test_cases,
        DEFAULT_SCRIPT_PATH,
        app_package=APP_PACKAGE,
        app_activity=APP_ACTIVITY,
    )

    if args.skip_execution:
        print("\n[pipeline] --skip-execution set. Stopping before test run.")
        print(f"  Script saved to: {DEFAULT_SCRIPT_PATH}")
        return

    # ── Stage 4: Execute test cases ───────────────────────────────────────────
    print("\n[pipeline] Stage 4: Executing test cases on device...")
    driver = build_driver()
    time.sleep(4)  # wait for app to fully launch

    try:
        results = execute_test_cases(
            test_cases,
            driver,
            str(SCREENSHOTS_DIR),
        )
    finally:
        driver.quit()
        print("[pipeline] Driver closed.")

    # ── Stage 5: Generate report ──────────────────────────────────────────────
    print("\n[pipeline] Stage 5: Generating execution report...")
    generate_report(results, DEFAULT_REPORT_PATH)

    print("\n[pipeline] Pipeline complete.")
    print(f"  Memory log    : {args.log_path}")
    print(f"  Test cases    : {DEFAULT_TEST_CASES_PATH}")
    print(f"  Script        : {DEFAULT_SCRIPT_PATH}")
    print(f"  Report        : {DEFAULT_REPORT_PATH}")
    print(f"  Screenshots   : {SCREENSHOTS_DIR}/")


if __name__ == "__main__":
    main()
