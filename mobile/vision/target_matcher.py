"""Resolve a recorded test target against controls detected on the live screen."""

import re
from difflib import SequenceMatcher


_TYPE_GROUPS = (
    {"button", "icon", "tab", "link", "menu", "dropdown", "accessibility", "text"},
    {"input", "text_field", "edittext"},
    {"checkbox", "switch", "radio", "toggle"},
)


def _normalise(value):
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", str(value or "").casefold()).split())


def _text_score(a, b):
    a, b = _normalise(a), _normalise(b)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    ratio = SequenceMatcher(None, a, b).ratio()
    aa, bb = set(a.split()), set(b.split())
    overlap = len(aa & bb) / len(aa | bb) if aa | bb else 0.0
    return max(ratio, overlap * 0.9, 0.85 if a in b or b in a else 0.0)


def _type_compatible(expected, actual):
    expected, actual = _normalise(expected), _normalise(actual)
    if not expected or not actual or expected == actual:
        return True
    return any(expected in group and actual in group for group in _TYPE_GROUPS)


def _norm_center(element, screen_width, screen_height):
    center = element.get("norm_center")
    if isinstance(center, (list, tuple)) and len(center) == 2:
        try:
            return float(center[0]), float(center[1])
        except (TypeError, ValueError):
            pass
    bbox = element.get("bbox")
    if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
        return None
    if not screen_width or not screen_height:
        return None
    x1, y1, x2, y2 = (float(value) for value in bbox)
    return ((x1 + x2) / (2 * screen_width), (y1 + y2) / (2 * screen_height))


def resolve_target(target, elements, screen_size, action):
    """Return (element, diagnostics); uncertain or ambiguous matches are rejected."""
    target = target if isinstance(target, dict) else {"text": str(target or "")}
    expected_text = target.get("text") or target.get("target_text") or ""
    expected_resource_id = str(target.get("resource_id") or "").strip()
    expected_type = target.get("type") or ""
    expected_pos = target.get("norm_center")
    width, height = screen_size

    candidates = []
    for element in elements:
        bbox = element.get("bbox")
        if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
            continue
        if action == "type" and not (
            element.get("editable")
        ):
            continue
        if action == "tap" and not (element.get("clickable") or element.get("checkable")):
            continue

        text_score = _text_score(expected_text, element.get("text"))
        resource_id_match = bool(
            expected_resource_id and
            str(element.get("resource_id") or "").strip() == expected_resource_id
        )
        type_ok = _type_compatible(expected_type, element.get("type"))
        actual_pos = _norm_center(element, width, height)
        position_score = 0.0
        if expected_pos and actual_pos:
            try:
                distance = ((float(expected_pos[0]) - actual_pos[0]) ** 2 +
                            (float(expected_pos[1]) - actual_pos[1]) ** 2) ** 0.5
                position_score = max(0.0, 1.0 - distance / 0.25)
            except (TypeError, ValueError, IndexError):
                position_score = 0.0

        if resource_id_match:
            score = 1.0 + 0.4 * text_score + 0.12 * position_score
            acceptable = not expected_text or text_score >= 0.72
        elif expected_text:
            score = 0.72 * text_score + 0.16 * float(type_ok) + 0.12 * position_score
            acceptable = text_score >= 0.72
        else:
            score = 0.55 * float(type_ok) + 0.45 * position_score
            acceptable = type_ok and position_score >= 0.82
        if acceptable:
            candidates.append((score, text_score, position_score, element))

    candidates.sort(key=lambda candidate: candidate[0], reverse=True)
    if not candidates:
        return None, {"method": "unresolved", "score": 0.0, "candidate_count": 0}

    best = candidates[0]
    if len(candidates) > 1 and best[0] - candidates[1][0] < 0.035:
        return None, {
            "method": "ambiguous",
            "score": round(best[0], 3),
            "candidate_count": len(candidates),
        }

    method = "resource_id_exact" if expected_resource_id and best[3].get("resource_id") == expected_resource_id else (
        "text_exact" if best[1] >= 0.99 else (
        "fuzzy_text" if expected_text and best[1] >= 0.72 else "type_and_position"
        )
    )
    return best[3], {
        "method": method,
        "score": round(best[0], 3),
        "text_score": round(best[1], 3),
        "position_score": round(best[2], 3),
        "candidate_count": len(candidates),
    }
