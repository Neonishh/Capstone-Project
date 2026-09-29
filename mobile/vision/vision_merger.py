"""
vision_merger.py
Module 4 — YOLO + OCR Merger

Responsibility:
  Combine YOLO UI component detections and OCR text extractions into a
  single structured JSON describing the current screen.

  Matching strategy: for each YOLO detection, find any OCR text whose
  bounding box overlaps or is contained within the component bbox.
  Assign that text to the component. Text regions with no matching
  YOLO component are added as standalone "text" elements.

  Output saved as vision_screen_<step>.json:
  {
    "step":     int,
    "screenshot": str,       # path to source screenshot
    "screen":   str,         # inferred screen name (from largest text or filename)
    "elements": [
      {
        "type":       str,   # from YOLO ("button", "text_field", etc.)
        "text":       str,   # from OCR match (empty if none)
        "bbox":       [x1, y1, x2, y2],
        "confidence": float  # YOLO confidence
      },
      ...
    ]
  }
"""

import json
import os
from pathlib import Path


def _safe_text(value: str) -> str:
    """Keep password-like values out of persisted vision artifacts."""
    text = (value or "").strip()
    if text and set(text) <= {"•", "*"}:
        return "[REDACTED]"
    return text


def _bbox_overlap(a: list, b: list) -> bool:
    """
    Returns True if bbox b overlaps or is contained within bbox a.
    Both bboxes are [x1, y1, x2, y2].
    """
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b

    # centre point of b
    bcx = (bx1 + bx2) / 2
    bcy = (by1 + by2) / 2

    return ax1 <= bcx <= ax2 and ay1 <= bcy <= ay2


def merge(
    step: int,
    screenshot_path: str,
    yolo_detections: list,
    ocr_results: list,
    output_dir: str,
    accessibility_results: list = None,
) -> dict:
    """
    Merges YOLO detections and OCR results into a single screen description.

    Args:
        step:             Current exploration step number
        screenshot_path:  Path to the source screenshot
        yolo_detections:  Output from yolo_detector.detect_ui_components()
        ocr_results:      Output from ocr_extractor.extract_text()
        output_dir:       Directory to save the merged JSON

    Returns:
        The merged screen dict (also saved to disk)
    """
    Path(output_dir).mkdir(parents=True, exist_ok=True)

    elements = []
    matched_ocr_indices = set()
    accessibility_results = accessibility_results or []

    # For each YOLO detection, find overlapping OCR text
    for det in yolo_detections:
        matched_texts = []
        for i, ocr in enumerate(ocr_results):
            if _bbox_overlap(det["bbox"], ocr["bbox"]):
                matched_texts.append(ocr["text"])
                matched_ocr_indices.add(i)

        elements.append({
            "type":       det["class"],
            "text":       _safe_text(" ".join(matched_texts)),
            "bbox":       det["bbox"],
            "confidence": det["confidence"],
        })

    # Add unmatched OCR regions as standalone text elements
    for i, ocr in enumerate(ocr_results):
        if i not in matched_ocr_indices:
            elements.append({
                "type": "text",
                    "text": _safe_text(ocr["text"]),
                "bbox": ocr["bbox"],
                "confidence": None,
            })

    # Accessibility bounds are the authoritative fallback when OCR is
        # unavailable. Add only entries not already represented by OCR/YOLO.
    existing = {
        (element.get("text", "").casefold(), tuple(element.get("bbox", []))): element
        for element in elements
    }
    for accessibility in accessibility_results:
        key = (
            (accessibility.get("text") or "").casefold(),
            tuple(accessibility.get("bbox") or []),
        )
        if key in existing:
            existing_element = existing[key]
            existing_element.update({
                "clickable": accessibility.get("clickable", False),
                "checkable": accessibility.get("checkable", False),
                "checked": accessibility.get("checked", False),
                "editable": accessibility.get("editable", False),
                "resource_id": accessibility.get("resource_id", ""),
            })
            continue
        elements.append({
            "type": accessibility.get("type", "accessibility"),
            "text": _safe_text(accessibility.get("text", "")),
            "bbox": accessibility.get("bbox"),
            "confidence": accessibility.get("confidence", 1.0),
            "clickable": accessibility.get("clickable", False),
            "checkable": accessibility.get("checkable", False),
            "checked": accessibility.get("checked", False),
            "editable": accessibility.get("editable", False),
            "resource_id": accessibility.get("resource_id", ""),
        })
        existing[key] = elements[-1]

    # Infer screen name from the largest text region
    screen_name = "unknown"
    title_candidates = [
        item for item in accessibility_results
        if item.get("is_title") and item.get("text")
    ]
    name_candidates = title_candidates or ocr_results or accessibility_results
    if name_candidates:
        largest = max(
            name_candidates,
            key=lambda o: (o["bbox"][2] - o["bbox"][0]) * (o["bbox"][3] - o["bbox"][1]),
        )
        screen_name = largest.get("text") or largest.get("content_desc") or "unknown"

    result = {
        "step":       step,
        "screenshot": screenshot_path,
        "screen":     screen_name,
        "elements":   elements,
        "detection_counts": {
            "yolo": len(yolo_detections),
            "ocr": len(ocr_results),
            "accessibility": len(accessibility_results),
            "merged": len(elements),
        },
    }

    output_path = str(Path(output_dir) / f"vision_screen_{step:02d}.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)

    print(f"[vision_merger] Step {step} → {len(elements)} element(s) merged → {output_path}")
    return result
