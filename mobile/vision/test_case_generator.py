"""Convert verified vision exploration actions into replayable test cases.

The generator uses only actions and target evidence recorded during the run.
It deliberately omits LLM-error fallback swipes and actions without a resolved
interactive target, rather than turning uncertain behavior into a test.
"""

import json
import re
from pathlib import Path


def _normalise(value):
    return " ".join(str(value or "").casefold().split())


def _replayable_step(entry):
    action = str(entry.get("action") or "").casefold()
    execution = entry.get("execution") or {}
    verification = execution.get("verification") or {}
    if execution.get("status") != "executed" or not verification.get("changed"):
        return None

    # A fallback swipe after LLM failure is a recovery operation, not a
    # deliberate behavior selected by the explorer, so do not encode it.
    if "llm_error" in str(entry.get("reason", "")) or str(entry.get("reason", "")).startswith("forced:"):
        return None

    if action in {"swipe", "back"}:
        if entry.get("reason") == "fallback_after_llm_error_no_untried_control":
            return None
        return {"action": action, "expect_change": True}

    if action not in {"tap", "type"}:
        return None

    control = entry.get("target_control") or {}
    if action == "tap" and not (control.get("clickable") or control.get("checkable")):
        return None
    if action == "type" and not control.get("editable"):
        return None

    # Exploration intentionally redacts typed data. Do not generate an
    # unreplayable fill step from a redacted or missing value.
    value = entry.get("value", "")
    if action == "type" and (not value or value == "[REDACTED]"):
        return None

    target = {
        "type": "accessibility",
        "text": control.get("text") or entry.get("target", ""),
    }
    if control.get("resource_id"):
        target["resource_id"] = control["resource_id"]
    if control.get("norm_center"):
        target["norm_center"] = control["norm_center"]

    step = {"action": action, "target": target, "expect_change": True}
    if action == "type":
        step["value"] = value
    return step


def generate_test_cases(history, output_path, run_id=None):
    """Write deduplicated behavior cases with shortest known clean setup paths."""
    import copy
    replay_path = []
    cases = []
    paths = {}
    seen = set()
    path_known = True
    for entry in history or []:
        if entry.get("action") == "restart":
            replay_path = []
            path_known = True
            continue
        source = entry.get("screen_key")
        if source and source in paths:
            replay_path = copy.deepcopy(paths[source])
            path_known = True
        elif source and path_known:
            paths[source] = copy.deepcopy(replay_path)
        step = _replayable_step(entry)
        if not step or not path_known:
            path_known = False
            continue
        execution = entry.get("execution") or {}
        control = entry.get("target_control") or {}
        setup = copy.deepcopy(replay_path)
        cleanup = []
        texts = execution.get("destination_titles") or []
        if not texts:
            new = {_normalise(t) for t in (execution.get("verification") or {}).get("new_text", [])}
            texts = [t for t in execution.get("visible_text_after", [])
                     if _normalise(t) in new and not re.search(r"\d|\[REDACTED\]", t)][:3]
        oracle = {"type": "postcondition", "texts": texts,
                  "activity": execution.get("activity_after")}
        if control.get("checkable"):
            if "radio" in str(control.get("control_type", "")).casefold():
                path_known = False
                continue
            target = step["target"]
            matches = [el for el in execution.get("controls_after", [])
                       if el.get("checkable") and
                       (not target.get("resource_id") or el.get("resource_id") == target["resource_id"]) and
                       (not target.get("text") or el.get("text") == target["text"])]
            if len(matches) != 1 or not isinstance(matches[0].get("checked"), bool):
                path_known = False
                continue
            baseline = {"action": "set_checked", "target": target,
                        "checked": bool(control.get("checked_before")), "expect_change": False}
            setup.append(baseline)
            cleanup = copy.deepcopy(setup)
            oracle = {"type": "control_state", "target": target,
                      "checked": matches[0]["checked"]}
        if step["action"] in {"tap", "type"} and (texts or oracle["type"] == "control_state"):
            signature = json.dumps([source or setup, step, oracle], sort_keys=True)
            if signature not in seen:
                seen.add(signature)
                cases.append({"id": f"TC{len(cases)+1:03d}",
                              "objective": "Verify " + (control.get("text") or entry.get("target") or "control"),
                              "category": "observed_regression", "setup": setup,
                              "steps": [step], "cleanup": cleanup,
                              "expected_result": json.dumps(oracle, ensure_ascii=False),
                              "verification": oracle,
                              "source": {"run_id": run_id, "exploration_step": entry.get("step")}})
        if control.get("checkable") or step["action"] == "type":
            # A mutated path is not a clean fixture for another independent case.
            path_known = False
        else:
            replay_path.append(step)
            destination = execution.get("screen_key_after")
            if destination and (destination not in paths or len(replay_path) < len(paths[destination])):
                paths[destination] = copy.deepcopy(replay_path)

    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(cases, indent=2, ensure_ascii=False), encoding="utf-8")
    return cases, str(output_path)


def write_run_summary(run_dir, history, cases, execution_report=None):
    """Write a compact index of artifacts and run outcome into the run folder."""
    run_dir = Path(run_dir)
    actions = [entry.get("action") for entry in history or []]
    summary = {
        "run_id": run_dir.name,
        "exploration_steps": len(history or []),
        "verified_actions": sum(
            bool((entry.get("execution") or {}).get("verification", {}).get("changed"))
            for entry in history or []
        ),
        "generated_test_cases": len(cases or []),
        "artifacts": {
            "screenshots": "screenshots/",
            "screen_json": "json/",
            "memory_log": "vision_memory_log.json",
            "test_cases": "vision_test_cases.json",
            "execution_report": "test_execution/vision_execution_report.json"
            if execution_report else None,
        },
        "execution_summary": (execution_report or {}).get("summary"),
        "actions": actions,
        "status": (
            "execution_complete" if execution_report else
            "cases_generated" if cases else
            "no_replayable_cases" if history else "no_exploration_data"
        ),
    }
    (run_dir / "run_summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return summary
