"""Coverage identities and explicit requirement scenarios (no model dependencies)."""
import copy
import hashlib
import json
from pathlib import Path


def screen_key(elements, activity=""):
    controls = sorted({(str(e.get("resource_id", "")), str(e.get("text", "")))
                       for e in elements if not e.get("editable")})
    return hashlib.sha256(json.dumps([activity, controls]).encode()).hexdigest()[:16]


def action_key(action, elements):
    index = action.get("element_index")
    element = elements[index] if isinstance(index, int) and 0 <= index < len(elements) else {}
    return json.dumps([action.get("action"), element.get("resource_id"),
                       element.get("text") or action.get("target"), element.get("bbox"),
                       action.get("value", "")], sort_keys=True)


class Coverage:
    def __init__(self):
        self.screens = {}
        self.actions = {}

    def choose(self, screen, action, elements):
        self.screens[screen] = self.screens.get(screen, 0) + 1
        tried = self.actions.setdefault(screen, set())
        key = action_key(action, elements)
        index = action.get("element_index")
        selected = elements[index] if isinstance(index, int) and 0 <= index < len(elements) else {}
        unsafe_fixture = action.get("action") == "type" or "radio" in str(selected.get("control_class") or selected.get("type", "")).casefold()
        if key in tried or action.get("action") == "done" or unsafe_fixture:
            for index, el in enumerate(elements):
                if "radio" in str(el.get("control_class") or el.get("type", "")).casefold():
                    continue
                if not (el.get("clickable") or el.get("checkable")) or not el.get("bbox"):
                    continue
                candidate = dict(action="tap", element_index=index, target=el.get("text", ""),
                                 bbox=el["bbox"], value="", reason="coverage_unvisited_control")
                if action_key(candidate, elements) not in tried:
                    action = candidate
                    break
            else:
                action = dict(action="swipe" if self.screens[screen] <= 2 else "back",
                              target="", reason="coverage_seek_new_screen")
        tried.add(action_key(action, elements))
        return action

    def summary(self):
        return {"distinct_screens": len(self.screens),
                "distinct_actions": sum(map(len, self.actions.values())),
                "screen_visits": self.screens}


def requirement_cases(path):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("Requirements must be a JSON array")
    cases = []
    allowed = {"valid", "invalid", "boundary", "cancellation", "persistence"}
    for requirement in data:
        for scenario in requirement.get("scenarios", []):
            if scenario.get("category") not in allowed:
                raise ValueError("Unknown requirement scenario category")
            if not scenario.get("steps") or not scenario.get("verification"):
                raise ValueError("Every scenario needs executable steps and an explicit verification")
            if not requirement.get("id") or not scenario.get("id"):
                raise ValueError("Requirement and scenario IDs are required")
            if "setup" not in scenario or "cleanup" not in scenario:
                raise ValueError("Specify setup and cleanup arrays, even when empty")
            def validate_oracle(oracle):
                kind = oracle.get("type")
                if kind == "all":
                    return bool(oracle.get("conditions")) and all(validate_oracle(c) for c in oracle["conditions"])
                if kind == "postcondition":
                    return bool(oracle.get("texts"))
                if kind == "control_state":
                    target = oracle.get("target") or {}
                    return bool(target.get("text") or target.get("resource_id")) and isinstance(oracle.get("checked"), bool)
                return False
            if not validate_oracle(scenario["verification"]):
                raise ValueError("Requirement oracle must be an exact postcondition, control_state, or all")
            for phase in ("setup", "steps", "cleanup"):
                if not isinstance(scenario[phase], list):
                    raise ValueError("Scenario phases must be arrays")
                for step in scenario[phase]:
                    if step.get("action") not in {"tap", "type", "back", "swipe", "relaunch", "set_checked"}:
                        raise ValueError("Unsupported scenario action")
            case = copy.deepcopy(scenario)
            case.update(id=f"REQ-{requirement['id']}-{scenario['id']}",
                        requirement_id=requirement["id"], source={"kind": "requirement"})
            cases.append(case)
    if len({c["id"] for c in cases}) != len(cases):
        raise ValueError("Duplicate requirement scenario IDs")
    return cases
