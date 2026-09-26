"""
yolo_detector.py
Module 2 — YOLO UI Component Detection

Responsibility:
  Run YOLOv8 object detection on a screenshot to identify UI components
  such as buttons, text fields, icons, checkboxes, and images.

  Uses ultralytics YOLOv8. For UI detection we use a pretrained general
  model (yolov8n.pt) as a fallback — ideally you'd fine-tune on a UI
  dataset, but for the demo the general model detects enough components
  to show the pipeline working.

  Output per detection:
  {
    "class":      str,    # e.g. "button", "text_field", "icon"
    "bbox":       [x1, y1, x2, y2],   # pixel coordinates
    "confidence": float   # 0.0 to 1.0
  }

Dependencies:
  pip install ultralytics
"""

from pathlib import Path

# YOLO class index → UI component name mapping.
# YOLOv8n trained on COCO doesn't have UI-specific classes, so we map
# the most visually similar COCO classes to UI terms for the demo.
# When a proper UI-trained YOLO model is available, replace this map.
_COCO_TO_UI = {
    "person":        "icon",
    "cell phone":    "button",
    "laptop":        "screen",
    "tv":            "screen",
    "keyboard":      "text_field",
    "mouse":         "button",
    "remote":        "button",
    "clock":         "icon",
    "book":          "image",
    "scissors":      "icon",
    "toothbrush":    "icon",
}

_DEFAULT_UI_CLASS = "ui_element"
_MIN_CONFIDENCE   = 0.25   # discard very low confidence detections


def detect_ui_components(image_path: str, model_path: str = "yolov8n.pt") -> list:
    """
    Runs YOLO detection on a screenshot and returns UI component annotations.

    Args:
        image_path: Path to the screenshot PNG
        model_path: Path to YOLO weights file (defaults to yolov8n.pt,
                    auto-downloaded by ultralytics on first run)

    Returns:
        List of detection dicts:
        [
          { "class": "button", "bbox": [x1, y1, x2, y2], "confidence": 0.94 },
          ...
        ]
    """
    try:
        from ultralytics import YOLO
    except ImportError:
        raise RuntimeError(
            "[yolo_detector] ultralytics not installed. Run: pip install ultralytics"
        )

    if not Path(image_path).exists():
        raise FileNotFoundError(f"[yolo_detector] Image not found: {image_path}")

    model   = YOLO(model_path)
    results = model(image_path, verbose=False)

    detections = []
    for result in results:
        for box in result.boxes:
            conf  = float(box.conf[0])
            if conf < _MIN_CONFIDENCE:
                continue

            # xyxy format: [x1, y1, x2, y2]
            x1, y1, x2, y2 = [int(v) for v in box.xyxy[0]]

            raw_class  = result.names[int(box.cls[0])]
            ui_class   = _COCO_TO_UI.get(raw_class, _DEFAULT_UI_CLASS)

            detections.append({
                "class":      ui_class,
                "bbox":       [x1, y1, x2, y2],
                "confidence": round(conf, 3),
            })

    print(f"[yolo_detector] {len(detections)} component(s) detected in {Path(image_path).name}")
    return detections
