"""Replay vision test cases by resolving targets on each live screen."""

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image

MOBILE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(MOBILE_DIR))

from vision import explore_vision as runner  # noqa: E402
from vision.action_verification import verify_action  # noqa: E402
from vision.coordinate_mapper import map_bbox_center  # noqa: E402
from vision.ocr_extractor import extract_text  # noqa: E402
from vision.screenshot_capture import capture_screenshot  # noqa: E402
from vision.target_matcher import resolve_target  # noqa: E402
from vision.vision_merger import merge  # noqa: E402
from vision.yolo_detector import detect_ui_components  # noqa: E402
from vision.accessibility_extractor import extract_accessibility  # noqa: E402
from src.database_storage import MobileRun, add_database_arguments  # noqa: E402
from vision.app_state import launch_start


def _observe(driver, case_dir, step, suffix):
    screenshot_path = capture_screenshot(driver, str(case_dir / "screenshots"), step, suffix=suffix)
    try:
        yolo = detect_ui_components(screenshot_path)
    except Exception as exc:
        print(f"[vision_test_executor] YOLO failed: {exc}")
        yolo = []
    try:
        ocr = extract_text(screenshot_path)
    except Exception as exc:
        print(f"[vision_test_executor] OCR failed: {exc}")
        ocr = []
    try:
        accessibility = extract_accessibility(driver)
    except Exception as exc:
        print(f"[vision_test_executor] Accessibility extraction failed: {exc}")
        accessibility = []

    data = merge(
        step=step,
        screenshot_path=screenshot_path,
        yolo_detections=yolo,
        ocr_results=ocr,
        output_dir=str(case_dir / "json"),
        accessibility_results=accessibility,
    )
    with Image.open(screenshot_path) as image:
        size = image.size
    return screenshot_path, data, accessibility, size


def _normalise_action(action):
    action = str(action or "").strip().casefold()
    if action == "entertext":
        return "type"
    if action == "scroll":
        return "swipe"
    return action


def _check_oracle(test, screen_data, accessibility, last_verification, activity=None):
    oracle = test.get("verification") or {}
    oracle_type = oracle.get("type")
    if oracle_type == "control_state":
        target = oracle.get("target") or {}
        matches = [el for el in accessibility
                   if el.get("checkable")
                   and (not target.get("resource_id") or el.get("resource_id") == target["resource_id"])
                   and (not target.get("text") or el.get("text") == target["text"])]
        ok = bool(target.get("text") or target.get("resource_id")) and len(matches) == 1 and isinstance(oracle.get("checked"), bool) and matches[0].get("checked") == oracle["checked"]
        return ok, {"type": oracle_type, "expected": oracle, "matches": matches}
    if oracle_type == "all":
        checks = [_check_oracle({"verification": child}, screen_data, accessibility, last_verification, activity)
                  for child in oracle.get("conditions", [])]
        return bool(checks) and all(ok for ok, _ in checks), {"type": "all", "checks": [detail for _, detail in checks]}
    if oracle_type == "postcondition":
        visible = {" ".join(str(item.get("text", "")).casefold().split()) for item in accessibility}
        missing = [text for text in oracle.get("texts", [])
                   if " ".join(text.casefold().split()) not in visible]
        activity_ok = not oracle.get("activity") or oracle["activity"] == activity
        ok = bool(oracle.get("texts")) and not missing and activity_ok
        return ok, {"type": oracle_type, "missing_texts": missing,
                    "expected_activity": oracle.get("activity"), "actual_activity": activity}
    if oracle_type == "text_visible":
        expected = oracle.get("texts") or []
        visible = [item.get("text", "") for item in accessibility if item.get("text")]
        matched = next((
            wanted for wanted in expected
            if any(wanted.casefold() in found.casefold() or found.casefold() in wanted.casefold()
                   for found in visible if wanted and found)
        ), None)
        return bool(matched), {"type": oracle_type, "matched_text": matched, "expected": expected}
    if oracle_type == "activity_changed":
        ok = bool(last_verification and "activity_changed" in last_verification.get("evidence", []))
        return ok, {"type": oracle_type, "ok": ok}
    if oracle_type == "screen_changed":
        ok = bool(last_verification and (
            last_verification.get("screen_title_changed")
            or last_verification.get("activity_changed")
        ))
        return ok, {"type": oracle_type, "ok": ok}
    return False, {"type": "unsupported_or_missing_oracle", "ok": False}


def execute_test(driver, test, run_dir, test_index, app_package, app_activity=None, _phase=False):
    test_id = str(test.get("id") or test.get("test_case_id") or f"TC{test_index:03d}")
    title = test.get("objective") or test.get("title") or test_id
    case_dir = run_dir / "cases" / test_id
    for name in ("screenshots", "json", "debug"):
        (case_dir / name).mkdir(parents=True, exist_ok=True)

    result = {
        "test_case": test_id,
        "title": title,
        "status": "PASS",
        "steps": [],
        "started_at": datetime.now(timezone.utc).isoformat(),
    }
    start_time = time.time()
    last_verification = None
    try:
        preconditions = test.get("preconditions") or {}
        launch_start(driver, app_package, preconditions.get("app_activity") or app_activity or runner.DEFAULT_APP_ACTIVITY)
        before_path, screen_data, accessibility, image_size = _observe(
            driver, case_dir, 0, "start"
        )

        steps = (test.get("setup") or []) + (test.get("steps") or [])
        if not steps:
            raise ValueError("Test case has no steps")

        for index, step in enumerate(steps, 1):
            action_name = _normalise_action(step.get("action"))
            if action_name == "relaunch":
                launch_start(driver, app_package, preconditions.get("app_activity") or app_activity or runner.DEFAULT_APP_ACTIVITY)
                before_path, screen_data, accessibility, image_size = _observe(driver, case_dir, index, "relaunch")
                continue
            step_result = {"step": index, "action": action_name}
            result["steps"].append(step_result)
            target_data = step.get("target") or step.get("target_text") or {}
            if not isinstance(target_data, dict):
                target_data = {"text": str(target_data)}
            if not target_data.get("resource_id") and step.get("resource_id"):
                target_data["resource_id"] = step["resource_id"]

            action = {"action": action_name, "value": step.get("value", ""),
                      "target": target_data.get("text") or target_data.get("resource_id", ""),
                      "clear": bool(step.get("clear")),
                      "_screenshot_path": before_path,
                      "_debug_dir": str(case_dir / "debug"), "_step": index}

            if action_name in ("tap", "type", "set_checked"):
                element, resolution = resolve_target(target_data, screen_data.get("elements", []),
                                                     image_size, "tap" if action_name == "set_checked" else action_name)
                step_result["target_resolution"] = resolution
                if element is None:
                    raise RuntimeError(f"Could not uniquely resolve live target: {action['target']!r}")
                if action_name == "set_checked":
                    if not isinstance(step.get("checked"), bool) or not element.get("checkable"):
                        raise ValueError("set_checked requires a boolean and a checkable target")
                    if element.get("checked") == step["checked"]:
                        step_result["already_satisfied"] = True
                        continue
                    action["action"] = "tap"
                action["bbox"] = element["bbox"]
                action["target"] = element.get("text") or action["target"]

            before_screen = screen_data.get("screen", "unknown")
            try:
                activity_before = driver.current_activity
            except Exception:
                activity_before = None
            execution = runner.execute_action(driver, action)
            step_result["execution"] = execution
            if execution.get("status") != "executed":
                raise RuntimeError(f"Action was not executed: {execution.get('reason', execution.get('status'))}")

            time.sleep(1.0)
            after_path, after_data, after_accessibility, after_size = _observe(
                driver, case_dir, index, f"after_{index}"
            )
            try:
                activity_after = driver.current_activity
            except Exception:
                activity_after = None
            verification = verify_action(
                before_path, after_path, before_screen, after_data.get("screen", "unknown"),
                screen_data.get("elements", []), after_data.get("elements", []), action.get("bbox"),
                activity_before=activity_before, activity_after=activity_after,
            )
            if action_name == "set_checked":
                state_ok, _ = _check_oracle({"verification": {"type": "control_state", "target": target_data,
                                            "checked": step["checked"]}}, after_data, after_accessibility, verification)
                if not state_ok:
                    raise RuntimeError("Could not establish requested checked state")
            step_result["verification"] = verification
            step_result["effect_detected"] = verification["changed"]
            last_verification = verification

            if step.get("expect_change", True) and not verification["changed"]:
                raise RuntimeError(f"Action had no detected effect at step {index}")

            before_path, screen_data, accessibility, image_size = (
                after_path, after_data, after_accessibility, after_size
            )

        oracle_ok, oracle_detail = _check_oracle(test, screen_data, accessibility, last_verification,
                                               driver.current_activity)
        result["oracle"] = {**oracle_detail, "ok": oracle_ok}
        if _phase:
            oracle_ok = True
        if not oracle_ok:
            result["status"] = "FAIL"
            result["error"] = "Final expected-result check was not satisfied"
    except Exception as exc:
        result["status"] = "FAIL"
        result["error"] = str(exc)

    finally:
        if test.get("cleanup") and not _phase:
            cleanup = execute_test(driver, {"id": test_id + "-cleanup", "steps": test["cleanup"],
                                           "preconditions": test.get("preconditions", {})},
                                   run_dir, test_index, app_package, app_activity, _phase=True)
            result["cleanup"] = cleanup
            if cleanup["status"] != "PASS":
                result["status"] = "FAIL"
                result["error"] = (result.get("error", "") + "; cleanup failed: " + cleanup.get("error", "")).lstrip("; ")

    result["execution_time_seconds"] = round(time.time() - start_time, 2)
    result["finished_at"] = datetime.now(timezone.utc).isoformat()
    (case_dir / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"[vision_test_executor] {test_id}: {result['status']}"
          + (f" - {result['error']}" if result.get("error") else ""))
    return result


def execute_all(driver, tests, run_dir, app_package, database_session=None, app_activity=None):
    run_dir = Path(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    results = []
    finished = False
    try:
        for index, test in enumerate(tests, 1):
            results.append(execute_test(driver, test, run_dir, index, app_package, app_activity))
        finished = True
    finally:
        if database_session:
            database_session.save(results, finished=finished)
    total = len(results)
    passed = sum(item["status"] == "PASS" for item in results)
    report = {
        "run_id": run_dir.parent.name if run_dir.name == "test_execution" else run_dir.name,
        "architecture": "B-vision-mobile",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "summary": {"total": total, "passed": passed, "failed": total - passed,
                    "pass_rate": f"{(passed / total * 100 if total else 0):.1f}%"},
        "results": results,
    }
    report_path = run_dir / "vision_execution_report.json"
    with open(report_path, "w", encoding="utf-8") as file:
        json.dump(report, file, indent=2, ensure_ascii=False)
    print(f"[vision_test_executor] Report saved: {report_path}")
    print(f"[vision_test_executor] {passed}/{total} test case(s) passed")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    add_database_arguments(parser)
    parser.add_argument("test_cases", help="JSON file containing an array of vision test cases")
    parser.add_argument("--app-package", default=runner.DEFAULT_APP_PACKAGE)
    parser.add_argument("--app-activity", default=runner.DEFAULT_APP_ACTIVITY)
    args = parser.parse_args()

    with open(args.test_cases, encoding="utf-8") as file:
        tests = json.load(file)
    if not isinstance(tests, list):
        raise ValueError("Test case JSON must contain an array")

    # Keep replay evidence beside the case file so a run remains self-contained.
    cases_path = Path(args.test_cases).expanduser().resolve()
    run_dir = cases_path.parent / "test_execution"
    run_dir.mkdir(parents=True, exist_ok=True)
    session = None
    if args.comparison:
        memory_path = cases_path.parent / "vision_memory_log.json"
        if not memory_path.is_file():
            raise ValueError("Database saving requires vision_memory_log.json beside the case file")
        memory = json.loads(memory_path.read_text(encoding="utf-8"))
        session = MobileRun("B", args.app or args.app_package, args.comparison, memory, tests)
        session.save([])
    driver = runner.build_driver(args.app_package, args.app_activity)
    try:
        execute_all(driver, tests, run_dir, args.app_package, database_session=session,
                    app_activity=args.app_activity)
    finally:
        driver.quit()


if __name__ == "__main__":
    main()
