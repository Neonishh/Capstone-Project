"""Convert verified vision exploration actions into replayable test cases.

The generator uses only actions and target evidence recorded during the run.
It deliberately omits LLM-error fallback swipes and actions without a resolved
interactive target, rather than turning uncertain behavior into a test.
"""

import json
from pathlib import Path
from vision.quality import stable_text, transient_text, target_identity, normalise
from vision.input_data import fixture_value


def _normalise(value):
    return " ".join(str(value or "").casefold().split())


def _replayable_step(entry):
    action = str(entry.get("action") or "").casefold()
    execution = entry.get("execution") or {}
    verification = execution.get("verification") or {}
    if execution.get("status") != "executed" or (not verification.get("changed") and not entry.get("input_fixture")) or execution.get("in_scope") is False:
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
    if action == "type" and not entry.get("input_fixture") and (not value or value == "[REDACTED]"):
        return None

    target = {
        "type": "accessibility",
        "text": control.get("text") or entry.get("target", ""),
    }
    if control.get("resource_id"):
        target["resource_id"] = control["resource_id"]
    if control.get("accessibility_id"):
        target = {"accessibility_id": control["accessibility_id"]}
    if control.get("norm_center"):
        target["norm_center"] = control["norm_center"]

    step = {"action": action, "target": target, "expect_change": True}
    if action == "type":
        if entry.get("input_fixture"):
            fixture_value(entry["input_fixture"])  # Refuse invalid references before writing a case.
            step.update(input_fixture=entry["input_fixture"], clear=True, hide_keyboard=True, expect_change=False)
        else:
            step["value"] = value
    return step


def generate_test_cases(history, output_path, run_id=None):
    """Write deduplicated behavior cases with shortest known clean setup paths."""
    import copy
    replay_path = []
    review = []
    cases = []
    paths = {}
    seen = set()
    path_known = True
    for entry in history or []:
        if entry.get("behavior_id"):
            continue  # Complete profile scenarios are emitted once, not as duplicate button cases.
        if entry.get("action") in {"restart", "relaunch"}:
            replay_path = []
            path_known = True
            continue
        source = entry.get("state_key") or entry.get("screen_key")
        if source and source in paths:
            replay_path = copy.deepcopy(paths[source])
            path_known = True
        elif source and path_known:
            paths[source] = copy.deepcopy(replay_path)
        step = _replayable_step(entry)
        if not step or not path_known:
            review.append({"step": entry.get("step"), "reason": "unreplayable_action_or_unknown_setup"})
            # A proven no-op with identical screen identity leaves the clean path intact.
            if not (path_known and source and source == (entry.get("execution") or {}).get("screen_key_after")
                    and (entry.get("execution") or {}).get("status") == "executed"
                    and (entry.get("execution") or {}).get("in_scope") is not False):
                path_known = False
            continue
        execution = entry.get("execution") or {}
        control = entry.get("target_control") or {}
        setup = copy.deepcopy(replay_path)
        cleanup = []
        controls = execution.get("controls_after") or []
        if any(transient_text(t) for t in execution.get("visible_text_after", [])) or execution.get("settle", {}).get("settled") is False:
            review.append({"step": entry.get("step"), "reason": "transient_or_unsettled_destination"})
            path_known = False
            continue
        texts = [t for t in execution.get("destination_titles", []) if stable_text(t)]
        if not texts:
            new = {_normalise(t) for t in (execution.get("verification") or {}).get("new_text", [])}
            texts = [t for t in execution.get("visible_text_after", [])
                     if _normalise(t) in new and stable_text(t)][:3]
        oracle = {"type": "postcondition", "texts": texts,
                  "activity": execution.get("activity_after")}
        if step["action"] == "type" and step.get("input_fixture") and not control.get("password"):
            oracle = {"type": "control_value", "target": step["target"], "input_fixture": step["input_fixture"]}
            texts = []
        # Search entry is best verified by the editable control itself, not a Back label.
        editable = [el for el in controls if el.get("editable") and el.get("resource_id")]
        if not texts and len(editable) == 1 and oracle["type"] != "control_value":
            oracle = {"type": "control_present", "target": {"resource_id": editable[0]["resource_id"]},
                      "editable": True, "activity": execution.get("activity_after")}
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
        if step["action"] in {"tap", "type"} and (texts or oracle["type"] in {"control_state", "control_present", "control_value"}):
            # Behavior identity ignores positions, viewport IDs, and incidental label ordering.
            context = entry.get("activity_before") or (target_identity((setup[-1].get("target") or {})) if setup else "launch")
            semantic_oracle = dict(oracle)
            if "texts" in semantic_oracle:
                semantic_oracle["texts"] = sorted(normalise(t) for t in semantic_oracle["texts"])
            if semantic_oracle.get("target"):
                semantic_oracle["target"] = target_identity(semantic_oracle["target"])
            signature = json.dumps([context, step["action"], target_identity(step.get("target") or {}),
                                    step.get("input_fixture") or step.get("value"), semantic_oracle], sort_keys=True)
            if signature not in seen:
                seen.add(signature)
                cases.append({"id": f"TC{len(cases)+1:03d}",
                              "objective": ("Verify entered value in " if step["action"] == "type" else "Verify ") + (control.get("text") or entry.get("target") or "control"),
                              "category": "input" if step["action"] == "type" else "observed_regression", "setup": setup,
                              "steps": [step], "cleanup": cleanup,
                              "expected_result": json.dumps(oracle, ensure_ascii=False),
                              "verification": oracle,
                              "source": {"run_id": run_id, "exploration_step": entry.get("step")}})
            else:
                review.append({"step": entry.get("step"), "reason": "duplicate_behavior"})
        else:
            review.append({"step": entry.get("step"), "reason": "no_specific_postcondition"})
        if control.get("checkable") or (step["action"] == "type" and not step.get("input_fixture")):
            # A mutated path is not a clean fixture for another independent case.
            path_known = False
        else:
            replay_path.append(step)
            destination = execution.get("state_key_after") or execution.get("screen_key_after")
            if destination and (destination not in paths or len(replay_path) < len(paths[destination])):
                paths[destination] = copy.deepcopy(replay_path)

    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(cases, indent=2, ensure_ascii=False), encoding="utf-8")
    output_path.with_name("generation_review.json").write_text(json.dumps({
        "generated": len(cases), "excluded": review,
        "note": "Observed regressions; expectations are not requirements validation."
    }, indent=2), encoding="utf-8")
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
