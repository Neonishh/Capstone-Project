"""Run a configurable YOLO detector on Android screenshots.

Set ``MOBILE_YOLO_MODEL`` to a UI-trained Ultralytics ``.pt`` file. The
default ``yolov8n.pt`` remains available as a generic-object fallback, but it
is not trained to recognize Android controls.
"""

import os
from functools import lru_cache
from pathlib import Path


MOBILE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_MODEL = "yolov8n.pt"
DEFAULT_CONFIDENCE = 0.25

# Keep compatibility with the old generic COCO model. These labels are only
# useful when running a COCO model; they do not make COCO a UI detector.
_COCO_TO_UI = {
    "person": "icon",
    "cell phone": "button",
    "laptop": "screen",
    "tv": "screen",
    "keyboard": "text_field",
    "mouse": "button",
    "remote": "button",
    "clock": "icon",
    "book": "image",
    "scissors": "icon",
    "toothbrush": "icon",
}

# Normalize common class names used by mobile GUI datasets to the vocabulary
# consumed by the rest of this pipeline. Unlisted class names are preserved.
_UI_CLASS_ALIASES = {
    "button": "button",
    "text button": "button",
    "image button": "button",
    "icon button": "button",
    "input": "text_field",
    "text input": "text_field",
    "input field": "text_field",
    "edit text": "text_field",
    "edittext": "text_field",
    "text field": "text_field",
    "textfield": "text_field",
    "search box": "text_field",
    "checkbox": "checkbox",
    "check box": "checkbox",
    "switch": "switch",
    "toggle": "switch",
    "radio button": "radio",
    "radio": "radio",
    "radiobutton": "radio",
    "tab": "tab",
    "text view": "text",
    "textview": "text",
    "label": "text",
    "image view": "image",
    "imageview": "image",
    "icon": "icon",
    "link": "link",
    "toolbar": "toolbar",
    "header bar": "toolbar",
}


def _configured_model_path(model_path=None) -> str:
    """Resolve explicit/env paths relative to cwd or the mobile project."""
    configured = model_path or os.environ.get("MOBILE_YOLO_MODEL") or DEFAULT_MODEL
    candidate = Path(configured).expanduser()

    if candidate.is_absolute():
        if not candidate.is_file():
            raise FileNotFoundError(f"[yolo_detector] Model weights not found: {candidate}")
        return str(candidate.resolve())

    # First honor a path relative to the caller's current working directory.
    if candidate.is_file():
        return str(candidate.resolve())

    # Then honor paths relative to the mobile/ folder, independent of where
    # the script was launched from.
    project_candidate = MOBILE_DIR / candidate
    if project_candidate.is_file():
        return str(project_candidate.resolve())

    # Ultralytics recognizes built-in model names such as yolov8n.pt and may
    # download them on first use. Custom missing .pt paths should fail clearly.
    if str(configured) == DEFAULT_MODEL:
        return DEFAULT_MODEL
    raise FileNotFoundError(
        f"[yolo_detector] Model weights not found: {configured}. "
        "Set MOBILE_YOLO_MODEL to an existing weights file."
    )


@lru_cache(maxsize=4)
def _load_model(model_path: str):
    """Load each configured model once per process, not once per screenshot."""
    try:
        from ultralytics import YOLO
    except ImportError as exc:
        raise RuntimeError(
            "[yolo_detector] ultralytics not installed. Run: pip install ultralytics"
        ) from exc
    print(f"[yolo_detector] Loading model: {model_path}")
    return YOLO(model_path)


def _confidence_threshold() -> float:
    try:
        threshold = float(os.environ.get("MOBILE_YOLO_CONFIDENCE", DEFAULT_CONFIDENCE))
    except ValueError as exc:
        raise ValueError("MOBILE_YOLO_CONFIDENCE must be a number between 0 and 1") from exc
    if not 0 <= threshold <= 1:
        raise ValueError("MOBILE_YOLO_CONFIDENCE must be between 0 and 1")
    return threshold


def _normalize_class(raw_class: str) -> str:
    label = " ".join(str(raw_class).strip().casefold().replace("_", " ").replace("-", " ").split())
    if label in _UI_CLASS_ALIASES:
        return _UI_CLASS_ALIASES[label]
    if label in _COCO_TO_UI:
        return _COCO_TO_UI[label]
    # Preserve model-specific labels instead of collapsing every unknown
    # mobile UI class into the misleading generic "ui_element" label.
    return label.replace(" ", "_") or "ui_element"


def detect_ui_components(image_path: str, model_path: str = None) -> list:
    """Detect screen elements and return class, pixel bbox, and confidence.

    ``model_path`` overrides ``MOBILE_YOLO_MODEL``. The model must return
    Ultralytics-compatible boxes; model class names are normalized to common
    mobile UI names where possible and otherwise preserved.
    """
    image = Path(image_path).expanduser()
    if not image.is_file():
        raise FileNotFoundError(f"[yolo_detector] Image not found: {image_path}")

    model = _load_model(_configured_model_path(model_path))
    results = model(str(image), verbose=False)
    min_confidence = _confidence_threshold()

    detections = []
    for result in results:
        for box in result.boxes:
            confidence = float(box.conf[0])
            if confidence < min_confidence:
                continue

            x1, y1, x2, y2 = [int(value) for value in box.xyxy[0]]
            raw_class = result.names[int(box.cls[0])]
            detections.append({
                "class": _normalize_class(raw_class),
                "bbox": [x1, y1, x2, y2],
                "confidence": round(confidence, 3),
            })

    print(f"[yolo_detector] {len(detections)} component(s) detected in {image.name}")
    return detections
