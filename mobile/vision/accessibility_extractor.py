"""
Accessibility/UI hierarchy extraction for the vision pipeline.

Android's Appium page source contains visible text, content descriptions, and
screen bounds. This is a reliable fallback when OCR or a generic object
detector cannot identify UI controls.
"""

import xml.etree.ElementTree as ET


def _parse_bounds(bounds: str):
    """Convert Android bounds such as '[0,0][1080,200]' to xyxy."""
    try:
        parts = bounds.replace("][", ",").strip("[]").split(",")
        x1, y1, x2, y2 = (int(value) for value in parts)
        if x2 <= x1 or y2 <= y1:
            return None
        return [x1, y1, x2, y2]
    except (AttributeError, ValueError):
        return None


def extract_accessibility(driver) -> list:
    """Extract visible text and interactive bounds from Appium page source."""
    try:
        root = ET.fromstring(driver.page_source)
    except (ET.ParseError, AttributeError) as exc:
        print(f"[accessibility_extractor] XML parse failed: {exc}")
        return []

    raw_nodes = []
    seen = set()
    parents = {child: parent for parent in root.iter() for child in parent}
    for node in root.iter():
        if node.get("displayed", "false").lower() != "true":
            continue

        text = (node.get("text") or "").strip()
        content_desc = (node.get("content-desc") or "").strip()
        clickable = node.get("clickable", "false").lower() == "true"
        checkable = node.get("checkable", "false").lower() == "true"
        checked = node.get("checked", "false").lower() == "true"
        editable = node.get("class", "").endswith("EditText") or node.get("editable", "false").lower() == "true"
        label = text or content_desc
        bbox = _parse_bounds(node.get("bounds", ""))
        if not bbox:
            continue

        target_bbox = bbox
        target_clickable = clickable
        target_checkable = checkable
        target_checked = checked
        target_id = node.get("resource-id") or ""

        # A row's visible title is often a non-clickable child of a clickable
        # container. Point at the parent control while keeping the useful label.
        if label and not (clickable or checkable):
            ancestor = parents.get(node)
            while ancestor is not None:
                if (ancestor.get("clickable", "false").lower() == "true" or
                        ancestor.get("checkable", "false").lower() == "true"):
                    parent_bbox = _parse_bounds(ancestor.get("bounds", ""))
                    if parent_bbox:
                        target_bbox = parent_bbox
                        target_clickable = ancestor.get("clickable", "false").lower() == "true"
                        target_checkable = ancestor.get("checkable", "false").lower() == "true"
                        target_checked = ancestor.get("checked", "false").lower() == "true"
                        target_id = ancestor.get("resource-id") or target_id
                    break
                ancestor = parents.get(ancestor)

        if not (label or target_clickable or target_checkable):
            continue

        raw_nodes.append({
            "node": node,
            "label": label,
            "bbox": target_bbox,
            "clickable": target_clickable,
            "checkable": target_checkable,
            "checked": target_checked,
            "editable": editable,
            "resource_id": target_id,
        })

    elements = []
    interactive_nodes = [
        item for item in raw_nodes
        if item["clickable"] or item["checkable"]
    ]
    for item in raw_nodes:
        label = item["label"]
        if label and not (item["clickable"] or item["checkable"]):
            center_x = (item["bbox"][0] + item["bbox"][2]) / 2
            center_y = (item["bbox"][1] + item["bbox"][3]) / 2
            containing = [
                candidate for candidate in interactive_nodes
                if candidate["bbox"][0] <= center_x <= candidate["bbox"][2]
                and candidate["bbox"][1] <= center_y <= candidate["bbox"][3]
            ]
            if containing:
                # Use the smallest containing control to avoid selecting a
                # full-screen parent over the actual row or switch.
                control = min(
                    containing,
                    key=lambda candidate: (
                        candidate["bbox"][2] - candidate["bbox"][0]
                    ) * (candidate["bbox"][3] - candidate["bbox"][1]),
                )
                item["bbox"] = control["bbox"]
                item["clickable"] = control["clickable"]
                item["checkable"] = control["checkable"]
                item["checked"] = control["checked"]
                item["resource_id"] = control["resource_id"] or item["resource_id"]

        # Prefer useful labels. Unlabelled clickable containers are retained
        # because they may be the actual tap target for a visible child label.
        target_bbox = item["bbox"]
        target_clickable = item["clickable"]
        target_checkable = item["checkable"]
        target_checked = item["checked"]
        target_id = item["resource_id"]
        key = (label.casefold(), tuple(target_bbox), target_clickable, target_checkable)
        if key in seen:
            continue
        seen.add(key)
        safe_label = label[:200]
        if safe_label and (
            "password" in target_id.casefold()
            or set(safe_label) <= {"•", "*"}
        ):
            safe_label = "[REDACTED]"
        elements.append({
            "type": "accessibility",
            "text": safe_label,
            "bbox": target_bbox,
            "confidence": 1.0,
            "clickable": target_clickable,
            "checkable": target_checkable,
            "checked": target_checked,
            "editable": item["editable"],
            "resource_id": target_id,
            "is_title": any(token in target_id.casefold() for token in (
                "collapsing_toolbar", "alerttitle", "dialog_title"
            )),
        })

    print(f"[accessibility_extractor] {len(elements)} element(s) found")
    return elements
