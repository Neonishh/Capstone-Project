"""Coverage identities and explicit requirement scenarios (no model dependencies)."""
import copy
import hashlib
import json
import re
import time
from pathlib import Path
from vision.input_data import controlled_type


def normalise(value):
    return " ".join(str(value or "").casefold().split())


def transient_text(value):
    text = normalise(value).rstrip(". \u2026")
    return bool(re.match(r"^(checking info|loading|please wait|signing in|searching|connecting|syncing)(?:$|[ .])", text))


def stable_text(value):
    text = normalise(value)
    return bool(text and len(text) <= 120 and "[redacted]" not in text
                and text not in {"back", "navigate up", "close", "next"}
                and not transient_text(text)
                and not re.fullmatch(r"[\d\s:.,%/+-]+", text))


def target_identity(target):
    # Resource IDs may be shared by list rows, so preserve meaningful labels.
    if target.get("accessibility_id"):
        return ["accessibility_id", normalise(target["accessibility_id"])]
    label = normalise(target.get("text") or target.get("target"))
    label = re.sub(r"^button[-_](.+?)[-_]container$", r"\1", label).replace("sign-up", "sign up")
    resource = target.get("resource_id") or ""
    return [resource, label] if resource or label else ["position", target.get("norm_center") or target.get("bbox")]


def screen_key(elements, activity=""):
    controls = sorted({json.dumps([*target_identity(e), e.get("checked") if e.get("checkable") else None])
                       for e in elements
                       if not e.get("editable") and stable_text(e.get("text"))
                       and not str(e.get("resource_id", "")).endswith("/summary")
                       and not any(part in str(e.get("package", "")) for part in ("systemui", "inputmethod"))})
    return hashlib.sha256(json.dumps([activity, controls]).encode()).hexdigest()[:16]


def action_key(action, elements):
    index = action.get("element_index")
    element = elements[index] if isinstance(index, int) and 0 <= index < len(elements) else action
    return json.dumps([action.get("action"), target_identity(element), action.get("input_fixture") or action.get("value", ""), action.get("direction") if action.get("action") == "swipe" else None], sort_keys=True)


def input_target(element, package=None):
    return bool(element.get("editable") and element.get("bbox") and element.get("enabled", True)
                and (element.get("clickable") or element.get("focusable", True))
                and (not package or not element.get("package") or element["package"] == package))


def exploration_target(element, package=None):
    label = normalise(element.get("text"))
    return bool((element.get("clickable") or element.get("checkable")) and element.get("bbox")
                and (label or element.get("resource_id")) and not transient_text(label)
                and not element.get("editable")
                and "radio" not in str(element.get("control_class") or element.get("type", "")).casefold()
                and (not package or not element.get("package") or element["package"] == package))


class Coverage:
    def __init__(self):
        self.screens = {}
        self.actions = {}
        self.visits_since_recovery = {}
        self.no_effect_streak = 0
        self.no_effect_actions = 0
        self.recoveries = 0
        self.typed_fields = set()
        self.feature_visits = set()
        self.action_types = {}

    def visit(self, screen, action, elements):
        self.screens[screen] = self.screens.get(screen, 0) + 1
        self.visits_since_recovery[screen] = self.visits_since_recovery.get(screen, 0) + 1
        self.actions.setdefault(screen, set()).add(action_key(action, elements))
        kind = action.get("action", "unknown")
        self.action_types[kind] = self.action_types.get(kind, 0) + 1
        index = action.get("element_index")
        if kind == "tap" and isinstance(index, int) and 0 <= index < len(elements):
            label = normalise(elements[index].get("accessibility_id") or elements[index].get("text"))
            if label in {"home", "login", "forms", "swipe", "drag", "menu", "webview", "web"}:
                self.feature_visits.add(label)

    def recovery(self, screen, current_package, allowed_packages):
        if current_package not in allowed_packages:
            return "outside_app_scope"
        if self.no_effect_streak >= 3:
            return "three_actions_without_progress"
        if self.visits_since_recovery.get(screen, 0) >= 12:
            return "screen_visit_budget_exhausted"
        return None

    def record(self, changed):
        self.no_effect_streak = 0 if changed else self.no_effect_streak + 1
        self.no_effect_actions += int(not changed)

    def recovered(self, screen=None):
        self.no_effect_streak = 0
        self.recoveries += 1
        self.typed_fields.clear()
        if screen is not None:
            self.visits_since_recovery[screen] = 0

    def choose(self, screen, action, elements, package=None):
        self.screens[screen] = self.screens.get(screen, 0) + 1
        self.visits_since_recovery[screen] = self.visits_since_recovery.get(screen, 0) + 1
        tried = self.actions.setdefault(screen, set())
        key = action_key(action, elements)
        index = action.get("element_index")
        selected = elements[index] if isinstance(index, int) and 0 <= index < len(elements) else {}
        fields = [(i, el) for i, el in enumerate(elements) if input_target(el, package)]
        for i, el in fields:
            field_key = (screen, json.dumps(target_identity(el)))
            if field_key not in self.typed_fields:
                action = controlled_type(dict(element_index=i, bbox=el["bbox"], target=el.get("text", ""), reason="coverage_fill_unvisited_field"), el)
                self.typed_fields.add(field_key)
                key = action_key(action, elements)
                selected = el
                break
        if action.get("action") == "type" and input_target(selected, package):
            action = controlled_type(action, selected)
            key = action_key(action, elements)
        invalid = (action.get("action") == "type" and not input_target(selected, package)) or (action.get("action") == "tap" and not exploration_target(selected, package))
        feature_names = {"home", "login", "forms", "swipe", "drag", "menu", "webview", "web"}
        feature = lambda el: normalise(el.get("accessibility_id") or el.get("text")) if normalise(el.get("accessibility_id") or el.get("text")) in feature_names else None
        unvisited_features = {feature(el) for el in elements if exploration_target(el, package)} - self.feature_visits - {None}
        if action.get("action") == "tap" and feature(selected) in self.feature_visits and unvisited_features:
            invalid = True
        if key in tried or action.get("action") in {"done", "back", "swipe"} or invalid:
            candidates = [(i, el) for i, el in enumerate(elements) if exploration_target(el, package)]
            # Prefer feature rows over Search/profile/back controls when the model cannot progress.
            candidates.sort(key=lambda item: any(word in normalise(item[1].get("text"))
                                                for word in ("search", "profile", "account", "back", "navigate up")))
            if unvisited_features:
                candidates.sort(key=lambda item: feature(item[1]) not in unvisited_features)
            for index, el in candidates:
                candidate = dict(action="tap", element_index=index, target=el.get("text", ""),
                                 bbox=el["bbox"], value="", reason="coverage_unvisited_control")
                if action_key(candidate, elements) not in tried:
                    action = candidate
                    break
            else:
                action = dict(action="swipe" if self.screens[screen] <= 2 and self.no_effect_streak < 2 else "back",
                              target="", reason="coverage_seek_new_screen")
        tried.add(action_key(action, elements))
        index = action.get("element_index")
        if action.get("action") == "tap" and isinstance(index, int) and 0 <= index < len(elements) and feature(elements[index]):
            self.feature_visits.add(feature(elements[index]))
        kind = action.get("action", "unknown")
        self.action_types[kind] = self.action_types.get(kind, 0) + 1
        return action

    def summary(self):
        return {"distinct_screens": len(self.screens),
                "distinct_actions": sum(map(len, self.actions.values())),
                "no_effect_actions": self.no_effect_actions, "recoveries": self.recoveries,
                "screen_visits": self.screens, "action_types": self.action_types,
                "visited_features": sorted(self.feature_visits)}


def wait_for_screen(driver, observe, timeout=4, interval=0.5):
    """Poll cheap accessibility evidence; never wait indefinitely for a loading screen."""
    deadline = time.monotonic() + timeout
    previous = None
    samples = 0
    while True:
        elements = observe(driver)
        activity = driver.current_activity
        package = driver.current_package
        # Include editable text here to wait for typing/results, unlike coverage identity.
        signature = json.dumps([activity, package, sorted([
            (str(e.get("resource_id", "")), str(e.get("text", "")), str(e.get("value", "")), str(e.get("checked", "")))
            for e in elements])])
        loading = any(transient_text(e.get("text")) for e in elements)
        if elements and signature == previous and not loading:
            return elements, {"settled": True, "samples": samples + 1}
        # A slow first page-source response is not proof of an unstable UI.
        # Permit one confirmation snapshot for non-loading content, then stop.
        if time.monotonic() >= deadline and (samples >= 1 or loading):
            return elements, {"settled": False, "loading": loading, "samples": samples + 1}
        previous = signature
        samples += 1
        time.sleep(interval)


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
                if kind in {"all", "any"}:
                    return bool(oracle.get("conditions")) and all(validate_oracle(c) for c in oracle["conditions"])
                if kind in {"postcondition", "text_absent"}:
                    return bool(oracle.get("texts"))
                if kind == "control_present":
                    target = oracle.get("target") or {}
                    return bool(target.get("text") or target.get("resource_id") or target.get("accessibility_id"))
                if kind == "control_value":
                    target = oracle.get("target") or {}
                    return bool(target.get("text") or target.get("resource_id") or target.get("accessibility_id")) and any(k in oracle for k in ("value", "input_fixture", "value_env"))
                if kind == "control_state":
                    target = oracle.get("target") or {}
                    return bool(target.get("text") or target.get("resource_id") or target.get("accessibility_id")) and isinstance(oracle.get("checked"), bool)
                return False
            if not validate_oracle(scenario["verification"]):
                raise ValueError("Requirement oracle must be an exact postcondition, control_state, control_present, or all")
            for phase in ("setup", "steps", "cleanup"):
                if not isinstance(scenario[phase], list):
                    raise ValueError("Scenario phases must be arrays")
                for step in scenario[phase]:
                    if step.get("action") not in {"tap", "type", "back", "swipe", "relaunch", "set_checked", "drag"}:
                        raise ValueError("Unsupported scenario action")
            case = copy.deepcopy(scenario)
            case.update(id=f"REQ-{requirement['id']}-{scenario['id']}",
                        requirement_id=requirement["id"], source={"kind": "requirement"})
            cases.append(case)
    if len({c["id"] for c in cases}) != len(cases):
        raise ValueError("Duplicate requirement scenario IDs")
    return cases
