"""
run_pipeline.py
Full pipeline runner:
  JSONLogReader → TestCaseGenerator → ScriptGenerator → TestExecutor → ReportGenerator → SupabaseUpload

Usage:
  python run_pipeline.py
  python run_pipeline.py --log-path path/to/log.json

Environment variables:
  LLM_PROVIDER, GROQ_API_KEY, GEMINI_API_KEY, etc.
  APP_PACKAGE, APP_ACTIVITY  — app to run tests against
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DB_UPLOAD_ENABLED=true — for upload
  APP_ID, COMPARISON_ID — experiment identifiers
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).parent))
# Add database/ folder so save_run.py is importable
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'database'))

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


def _upload_to_supabase(memory_log: list, test_cases: list, results: list) -> None:
    """Converts results to Supabase schema and uploads."""
    try:
        from save_run import save_run_to_db
    except ImportError:
        print("[pipeline] Could not import save_run — is database/ folder present?")
        return

    # Convert our result format to required schema
    # Our: {"test_case": "TC001", "status": "PASS", "execution_time": "1.5s"}
    # Required: {"id": "TC001", "status": "passed", "duration_ms": 1500}
    status_map = {"PASS": "passed", "FAIL": "failed"}
    execution_results = []
    for r in results:
        tc_id = r.get("test_case") or r.get("id", "")
        status = status_map.get(r.get("status", "FAIL"), "failed")
        try:
            duration_ms = float(r.get("execution_time", "0s").replace("s", "")) * 1000
        except (ValueError, AttributeError):
            duration_ms = 0.0
        execution_results.append({
            "id": tc_id,
            "status": status,
            "duration_ms": duration_ms,
            "error": r.get("error"),
        })

    run_id = os.environ.get("RUN_ID") or \
        f"saucelabs-mobile-a-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
    app_id       = os.environ.get("APP_ID",       "saucelabs-demo")
    comparison_id = os.environ.get("COMPARISON_ID", "saucelabs-01")

    saved = save_run_to_db(dict(
        run_id=run_id,
        created_at=datetime.now(timezone.utc).isoformat(),
        platform="mobile",
        architecture="A",
        app_id=app_id,
        comparison_id=comparison_id,
        execution_state="completed",
        memory_log=memory_log,
        test_cases=test_cases,
        execution_results=execution_results,
    ))

    if saved.get("uploaded"):
        print(f"[pipeline] Uploaded to Supabase successfully. Run ID: {run_id}")
    else:
        print(f"[pipeline] Saved locally (not uploaded): {saved.get('reason')}")
        print(f"[pipeline] Run ID: {run_id}")
        print(f"[pipeline] To retry: cd /Users/nikita/Capstone-Project && python database/manage.py retry --env mobile/.env")


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

    # ── Stage 4: Execute test cases (each gets a fresh app launch) ───────────
    print("\n[pipeline] Stage 4: Executing test cases on device...")
    results = []
    for i, tc in enumerate(test_cases):
        tc_id = tc.get("test_case_id") or tc.get("id", f"TC{i+1:03d}")
        print(f"\n[pipeline] Launching app fresh for {tc_id}...")
        driver = build_driver()
        driver.implicitly_wait(10)
        time.sleep(4)
        try:
            tc_results = execute_test_cases([tc], driver, str(SCREENSHOTS_DIR))
            results.extend(tc_results)
        finally:
            try:
                driver.quit()
            except Exception:
                pass
        print(f"[pipeline] Driver closed after {tc_id}.")

    # ── Stage 5: Generate report ──────────────────────────────────────────────
    print("\n[pipeline] Stage 5: Generating execution report...")
    generate_report(results, DEFAULT_REPORT_PATH)

    print("\n[pipeline] Pipeline complete.")
    print(f"  Memory log    : {args.log_path}")
    print(f"  Test cases    : {DEFAULT_TEST_CASES_PATH}")
    print(f"  Script        : {DEFAULT_SCRIPT_PATH}")
    print(f"  Report        : {DEFAULT_REPORT_PATH}")
    print(f"  Screenshots   : {SCREENSHOTS_DIR}/")

    # ── Stage 6: Upload to Supabase ───────────────────────────────────────────
    if os.environ.get("DB_UPLOAD_ENABLED") == "true":
        print("\n[pipeline] Stage 6: Uploading to Supabase...")
        _upload_to_supabase(memory_log, test_cases, results)
    else:
        print("\n[pipeline] DB_UPLOAD_ENABLED not set — skipping Supabase upload.")
        print("  Add DB_UPLOAD_ENABLED=true to mobile/.env to enable.")


if __name__ == "__main__":
    main()
