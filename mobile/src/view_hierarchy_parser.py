"""
view_hierarchy_parser.py
Mobile equivalent of web/src/domExtractor.js

Responsibility:
  - get_view_hierarchy(driver)  → raw XML string from Appium
  - parse_elements(xml_source)  → list of raw element dicts
  - get_screen_meta(driver)     → { activity, package }

Each element dict:
  {
    "elementId": int,          # assigned sequentially here
    "tag":       str,          # Android class name, e.g. "android.widget.Button"
    "text":      str,
    "resource_id": str | None,
    "content_desc": str | None,
    "class_name": str,
    "clickable":  bool,
    "checkable":  bool,
    "bounds":     str,         # e.g. "[0,0][1080,200]"
    "package":    str,
  }
"""

import xml.etree.ElementTree as ET


# Android classes we consider interactive (mirrors ALLOWED_TAGS in preprocess.js)
INTERACTIVE_CLASSES = {
    "android.widget.Button",
    "android.widget.ImageButton",
    "android.widget.EditText",
    "android.widget.CheckBox",
    "android.widget.RadioButton",
    "android.widget.Switch",
    "android.widget.Spinner",
    "android.widget.TextView",          # included when clickable=true
    "android.view.View",                # included when clickable=true
    "android.widget.LinearLayout",      # included when clickable=true
    "android.widget.RelativeLayout",    # included when clickable=true
    "androidx.recyclerview.widget.RecyclerView",
}


def get_view_hierarchy(driver) -> str:
    """
    Fetches the current screen's view hierarchy XML from Appium.

    Args:
        driver: Appium WebDriver instance

    Returns:
        Raw XML string of the view hierarchy
    """
    return driver.page_source


def parse_elements(xml_source: str) -> list:
    """
    Parses Appium view hierarchy XML into a list of raw element dicts.
    Only returns elements that are visible and either:
      - belong to a known interactive class, OR
      - have clickable="true"

    Args:
        xml_source: Raw XML string from driver.page_source

    Returns:
        List of raw element dicts (unsorted, unfiltered beyond visibility)
    """
    try:
        root = ET.fromstring(xml_source)
    except ET.ParseError as e:
        print(f"[view_hierarchy_parser] XML parse error: {e}")
        return []

    results = []
    index = 0

    for node in root.iter():
        # Skip nodes that are not displayed
        if node.get("displayed", "false").lower() != "true":
            continue

        class_name = node.get("class", "")
        clickable = node.get("clickable", "false").lower() == "true"
        checkable = node.get("checkable", "false").lower() == "true"

        # Keep if it's a known interactive class OR explicitly clickable
        is_interactive_class = class_name in INTERACTIVE_CLASSES
        if not (is_interactive_class or clickable):
            continue

        # For generic views/layouts, only keep if clickable
        if class_name in {
            "android.view.View",
            "android.widget.LinearLayout",
            "android.widget.RelativeLayout",
        } and not clickable:
            continue

        text = (node.get("text") or "").strip()
        resource_id = node.get("resource-id") or None
        content_desc = node.get("content-desc") or None
        bounds = node.get("bounds") or ""
        package = node.get("package") or ""

        results.append({
            "elementId": index,
            "tag": class_name,
            "text": text[:100],          # cap long text (mirrors web side)
            "resource_id": resource_id,
            "content_desc": content_desc,
            "class_name": class_name,
            "clickable": clickable,
            "checkable": checkable,
            "bounds": bounds,
            "package": package,
        })
        index += 1

    return results


def get_screen_meta(driver) -> dict:
    """
    Returns current app screen metadata.
    Mobile equivalent of getPageMeta(page) in domExtractor.js.

    For mobile, 'url' = current activity name (used in memory log from_url/to_url).
    'title' = app package name.

    Args:
        driver: Appium WebDriver instance

    Returns:
        { "url": str, "title": str }
    """
    try:
        activity = driver.current_activity or "unknown_activity"
        package = driver.current_package or "unknown_package"
    except Exception as e:
        print(f"[view_hierarchy_parser] get_screen_meta error: {e}")
        activity = "unknown_activity"
        package = "unknown_package"

    return {
        "url": f"{package}/{activity}",   # mirrors web 'url' field
        "title": package,                  # mirrors web 'title' field
    }
