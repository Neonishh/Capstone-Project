"""Validate explicit WDIO functional contracts; this is not an AI generation benchmark."""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vision.behavior_profiles import wdio_cases
from vision.explore_vision import build_driver
from vision.vision_test_executor import execute_all

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", action="append", default=[], help="Scenario suffix, e.g. dropdown-select; repeat to select more")
    args = parser.parse_args()
    cases = wdio_cases()
    if args.case:
        wanted = {"BEH-WDIO-" + name for name in args.case}
        if wanted - {c["id"] for c in cases}:
            parser.error("Unknown functional scenario")
        cases = [c for c in cases if c["id"] in wanted]
    output = Path(__file__).resolve().parents[1] / "logs" / "benchmarks" / datetime.now(timezone.utc).strftime("wdio_functional_%Y%m%d_%H%M%SZ")
    output.mkdir(parents=True)
    (output / "vision_test_cases.json").write_text(json.dumps(cases, indent=2), encoding="utf-8")
    driver = build_driver("com.wdiodemoapp", ".MainActivity")
    try:
        report = execute_all(driver, cases, output / "test_execution", "com.wdiodemoapp", app_activity=".MainActivity")
        report.update(kind="explicit_profile_validation", profile="wdio-demo-v2.2.0", llm_calls=0)
        (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print("[functional validation] Report: " + str(output / "report.json"), flush=True)
        return int(report["summary"]["failed"] != 0)
    finally:
        driver.quit()

if __name__ == "__main__":
    raise SystemExit(main())
