"""Run YOLO and EasyOCR independently on a saved screenshot.

From the mobile directory:
    python vision/check_vision_models.py path/to/screenshot.png
"""

import argparse
import os
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except ImportError:
    pass

from ocr_extractor import extract_text
from yolo_detector import detect_ui_components


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Smoke-check YOLO and EasyOCR using a screenshot file."
    )
    parser.add_argument("image", type=Path, help="Screenshot image (PNG/JPG)")
    parser.add_argument(
        "--model",
        default=None,
        help="YOLO weights path (overrides MOBILE_YOLO_MODEL; default: env setting or yolov8n.pt)",
    )
    args = parser.parse_args()

    image_path = args.image.expanduser().resolve()
    if not image_path.is_file():
        parser.error(f"Screenshot not found: {image_path}")

    print(f"Image: {image_path}")
    print(f"YOLO model: {args.model or os.environ.get('MOBILE_YOLO_MODEL', 'yolov8n.pt')}")
    print("\n=== YOLO ===")
    try:
        detections = detect_ui_components(str(image_path), model_path=args.model)
        print(f"YOLO ran successfully: {len(detections)} detection(s)")
        for item in detections:
            print(
                f"  {item['class']}: bbox={item['bbox']} "
                f"confidence={item['confidence']}"
            )
        if not detections:
            print("  No objects passed the detector confidence threshold.")
    except Exception as exc:
        print(f"YOLO failed: {type(exc).__name__}: {exc}")

    print("\n=== EasyOCR ===")
    try:
        text_regions = extract_text(str(image_path))
        print(f"EasyOCR ran successfully: {len(text_regions)} text region(s)")
        for item in text_regions:
            print(f"  {item['text']!r}: bbox={item['bbox']}")
        if not text_regions:
            print("  No text was recognized in this screenshot.")
    except Exception as exc:
        print(f"EasyOCR failed: {type(exc).__name__}: {exc}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
