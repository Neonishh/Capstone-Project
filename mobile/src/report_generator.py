"""
report_generator.py

Responsibility:
  Takes the list of execution results from test_executor.py and produces
  a final JSON execution report with summary statistics.

  Output schema:
  {
    "run_id":        str,        # timestamp-based unique ID
    "generated_at":  str,        # ISO 8601
    "summary": {
      "total":   int,
      "passed":  int,
      "failed":  int,
      "pass_rate": str           # e.g. "80.0%"
    },
    "results": [
      {
        "test_case":      str,
        "title":          str,
        "status":         "PASS" | "FAIL",
        "execution_time": str,
        "timestamp":      str,
        "error":          str | null,
        "screenshot":     str | null
      },
      ...
    ]
  }
"""

import json
import os
from datetime import datetime, timezone


def generate_report(results: list, output_path: str) -> dict:
    """
    Builds and saves the execution report from test_executor results.

    Args:
        results:     List of result dicts from test_executor.execute_test_cases()
        output_path: Where to save the JSON report

    Returns:
        The full report dict
    """
    now = datetime.now(timezone.utc)
    run_id = now.strftime("RUN_%Y%m%d_%H%M%S")

    total  = len(results)
    passed = sum(1 for r in results if r.get("status") == "PASS")
    failed = total - passed
    pass_rate = f"{(passed / total * 100):.1f}%" if total > 0 else "0.0%"

    report = {
        "run_id":        run_id,
        "generated_at":  now.isoformat(),
        "summary": {
            "total":     total,
            "passed":    passed,
            "failed":    failed,
            "pass_rate": pass_rate,
        },
        "results": results,
    }

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    print(f"\n[report_generator] ══════════════════════════════")
    print(f"[report_generator]  Execution Report: {run_id}")
    print(f"[report_generator]  Total:  {total}")
    print(f"[report_generator]  Passed: {passed}")
    print(f"[report_generator]  Failed: {failed}")
    print(f"[report_generator]  Rate:   {pass_rate}")
    print(f"[report_generator]  Saved → {output_path}")
    print(f"[report_generator] ══════════════════════════════\n")

    return report
