"""Exact, inspectable assertions shared by exploration and replay."""
from vision.input_data import read_step_value

def matches(target, elements):
    keys = ("resource_id", "accessibility_id", "text", "hint")
    if not any(target.get(k) for k in keys):
        return []
    found, physical = [], set()
    for el in elements:
        if not all(not target.get(k) or el.get(k) == target[k] for k in keys) or ("editable" in target and el.get("editable") != target["editable"]):
            continue
        if el.get("bbox") and el.get("accessibility_id"):
            key = (el["accessibility_id"], tuple(el["bbox"]), bool(el.get("editable")))
            if key in physical:
                continue
            physical.add(key)
        found.append(el)
    return found

def check_oracle(test, screen_data, accessibility, last_verification, activity=None):
    oracle = test.get("verification") or {}
    kind = oracle.get("type")
    if kind == "text_in_view":
        wanted = " ".join(str(oracle.get("text", "")).casefold().split())
        width = screen_data.get("viewport_width") or max((el.get("bbox", [0,0,0,0])[2] for el in accessibility), default=0)
        found = [el for el in accessibility if " ".join(str(el.get("text", "")).casefold().split()) == wanted and el.get("bbox")]
        visible = [el for el in found if width and (el["bbox"][2] - el["bbox"][0]) / width >= oracle.get("min_width_fraction", 0.4)
                   and 0.15 <= (el["bbox"][0] + el["bbox"][2]) / (2*width) <= 0.85]
        return bool(wanted and len(visible) == 1), {"type": kind, "expected": oracle, "match_count": len(visible)}
    if kind in {"control_present", "control_state", "control_value"}:
        found = [el for el in matches(oracle.get("target") or {}, accessibility)
                 if "editable" not in oracle or el.get("editable") == oracle["editable"]]
        ok = len(found) == 1 and ("editable" not in oracle or found[0].get("editable") == oracle["editable"])
        detail = {"type": kind, "match_count": len(found), "expected": oracle}
        if kind == "control_state":
            ok = ok and found[0].get("checkable") and isinstance(oracle.get("checked"), bool) and found[0].get("checked") == oracle["checked"]
        elif kind == "control_value":
            expected = str(read_step_value(oracle))
            actual = str(found[0]["value"]) if found and "value" in found[0] else None
            ok = ok and actual == expected and actual != "[REDACTED]"
            detail.update(actual=actual, expected_value=expected)
        ok = bool(ok and (not oracle.get("activity") or oracle["activity"] == activity))
        return ok, detail
    if kind in {"all", "any"}:
        checks = [check_oracle({"verification": child}, screen_data, accessibility, last_verification, activity)
                  for child in oracle.get("conditions", [])]
        return bool(checks) and (all(ok for ok, _ in checks) if kind == "all" else any(ok for ok, _ in checks)), {"type": kind, "checks": [d for _, d in checks]}
    if kind in {"postcondition", "text_absent"}:
        normalise = lambda value: " ".join(str(value).casefold().split())
        visible = {normalise(el.get("text", "")) for el in accessibility}
        expected = oracle.get("texts") or []
        missing = [t for t in expected if normalise(t) not in visible]
        ok = bool(expected) and (not missing if kind == "postcondition" else len(missing) == len(expected))
        ok = ok and (not oracle.get("activity") or oracle["activity"] == activity)
        return ok, {"type": kind, "missing_texts": missing, "expected_activity": oracle.get("activity"), "actual_activity": activity}
    if kind == "text_visible":
        visible = [str(item.get("text", "")) for item in accessibility]
        matched = next((wanted for wanted in oracle.get("texts", []) if any(wanted.casefold() in found.casefold() for found in visible if wanted and found)), None)
        return bool(matched), {"type": kind, "matched_text": matched, "expected": oracle.get("texts", [])}
    if kind == "activity_changed":
        ok = bool(last_verification and "activity_changed" in last_verification.get("evidence", []))
        return ok, {"type": kind, "ok": ok}
    if kind == "screen_changed":
        ok = bool(last_verification and (last_verification.get("screen_title_changed") or last_verification.get("activity_changed")))
        return ok, {"type": kind, "ok": ok}
    return False, {"type": "unsupported_or_missing_oracle", "ok": False}
