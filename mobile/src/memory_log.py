"""
memory_log.py
Mobile equivalent of web/src/memoryLog.js

Responsibility:
  - store_step(log_list, step_data) — append a validated step entry
  - save_log(log_list, file_path)   — write log to JSON file
  - load_log(file_path)             — read existing log from JSON file

Schema per entry (IDENTICAL to web memory_log.json schema):
{
  "step":                   int,
  "from_url":               str,   # mobile: "package/activity"
  "from_title":             str,   # mobile: package name
  "action":                 str,   # "tap" | "type" | "swipe" | "error"
  "target":                 str,   # resource_id or class name
  "target_element_details": {
    "elementId":   int | None,
    "tag":         str,
    "text":        str,
    "id":          str | None,     # resource_id mapped to "id" for schema compat
    "class":       str,
    "selector":    str             # resource_id used as selector
  } | None,
  "to_url":             str,
  "to_title":           str,
  "screenshot_before":  str,       # relative path
  "screenshot_after":   str,       # relative path
  "timestamp":          str        # ISO 8601
}
"""

import json
import os
from datetime import datetime, timezone


def store_step(log_list: list, step_data: dict) -> None:
    """
    Appends a validated step entry to the in-memory log list.
    Mirrors storeStep() in memoryLog.js — same field names for schema compatibility.

    Args:
        log_list:  The shared in-memory log list
        step_data: Raw step data dict
    """
    if not isinstance(log_list, list):
        raise TypeError("log_list must be a list")

    ted = step_data.get("target_element_details")
    if ted:
        # Map mobile fields → web-compatible schema fields
        normalised_ted = {
            "elementId": ted.get("elementId"),
            "tag":       ted.get("tag", ""),
            "text":      ted.get("text", ""),
            "id":        ted.get("resource_id") or ted.get("id"),   # resource_id → id
            "class":     ted.get("class_name") or ted.get("class", ""),
            "selector":  ted.get("resource_id") or ted.get("selector", ""),
        }
    else:
        normalised_ted = None

    entry = {
        "step":                   step_data.get("step", len(log_list)),
        "from_url":               step_data.get("from_url", ""),
        "from_title":             step_data.get("from_title", ""),
        "action":                 step_data.get("action", "unknown"),
        "target":                 step_data.get("target", ""),
        "target_element_details": normalised_ted,
        "to_url":                 step_data.get("to_url", ""),
        "to_title":               step_data.get("to_title", ""),
        "screenshot_before":      step_data.get("screenshot_before", ""),
        "screenshot_after":       step_data.get("screenshot_after", ""),
        "timestamp":              step_data.get("timestamp", datetime.now(timezone.utc).isoformat()),
    }

    # Optional fields — only include if present (mirrors web side spread operator)
    if step_data.get("error"):
        entry["error"] = step_data["error"]
    if step_data.get("value"):
        entry["value"] = step_data["value"]

    log_list.append(entry)


def save_log(log_list: list, file_path: str) -> None:
    """
    Serialises the full log list to a JSON file.
    Creates parent directories if they don't exist.
    Mirrors saveLog() in memoryLog.js.

    Args:
        log_list:  The in-memory log list
        file_path: Destination file path (e.g. 'logs/mobile_memory_log.json')
    """
    os.makedirs(os.path.dirname(file_path), exist_ok=True)
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(log_list, f, indent=2)
    print(f"[memory_log] Saved {len(log_list)} step(s) → {file_path}")


def load_log(file_path: str) -> list:
    """
    Reads and parses an existing memory_log.json file.
    Returns empty list if file does not exist.
    Mirrors loadLog() in memoryLog.js.

    Args:
        file_path: Path to the JSON log file

    Returns:
        Parsed list of step dicts, or [] on missing/corrupt file
    """
    if not os.path.exists(file_path):
        return []
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        print(f"[memory_log] Failed to load {file_path}: {e}")
        return []
