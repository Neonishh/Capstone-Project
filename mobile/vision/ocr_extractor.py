"""
ocr_extractor.py
Module 3 — OCR Text Extraction

Responsibility:
  Run EasyOCR on a screenshot to extract all visible text and their
  bounding box coordinates on screen.

  Output per text region:
  {
    "text": str,
    "bbox": [x1, y1, x2, y2]   # pixel coordinates of text region
  }

Dependencies:
  pip install easyocr
"""

from pathlib import Path


def extract_text(image_path: str, languages: list = None) -> list:
    """
    Runs EasyOCR on a screenshot and returns all detected text with positions.

    Args:
        image_path: Path to the screenshot PNG
        languages:  List of language codes (default: ["en"])

    Returns:
        List of text region dicts:
        [
          { "text": "Login", "bbox": [130, 510, 330, 560] },
          ...
        ]
    """
    try:
        import easyocr
    except ImportError:
        raise RuntimeError(
            "[ocr_extractor] easyocr not installed. Run: pip install easyocr"
        )

    if languages is None:
        languages = ["en"]

    if not Path(image_path).exists():
        raise FileNotFoundError(f"[ocr_extractor] Image not found: {image_path}")

    # gpu=False works everywhere; set gpu=True if CUDA is available for speed
    reader  = easyocr.Reader(languages, gpu=False, verbose=False)
    raw     = reader.readtext(image_path)

    results = []
    skipped = 0
    for detection in raw:
        # Standard EasyOCR output is (quadrilateral, text, confidence).
        # Accept mapping/tuple wrappers too, and skip records without bounds.
        if isinstance(detection, dict):
            text = detection.get("text", "")
            bbox_points = detection.get("bbox") or detection.get("box")
        elif isinstance(detection, (list, tuple)) and len(detection) >= 2:
            bbox_points, text = detection[0], detection[1]
        else:
            skipped += 1
            continue
        if not isinstance(text, str):
            skipped += 1
            continue
        text = text.strip()
        if not text:
            continue

        # EasyOCR returns 4 corner points — convert to [x1, y1, x2, y2]
        try:
            if (isinstance(bbox_points, (list, tuple)) and len(bbox_points) == 4
                    and all(isinstance(value, (int, float)) for value in bbox_points)):
                xs = [int(bbox_points[0]), int(bbox_points[2])]
                ys = [int(bbox_points[1]), int(bbox_points[3])]
            else:
                xs = [int(point[0]) for point in bbox_points]
                ys = [int(point[1]) for point in bbox_points]
        except (TypeError, ValueError, IndexError):
            skipped += 1
            continue
        x1, y1, x2, y2 = min(xs), min(ys), max(xs), max(ys)

        results.append({
            "text": text,
            "bbox": [x1, y1, x2, y2],
        })

    print(f"[ocr_extractor] {len(results)} text region(s) found in {Path(image_path).name}")
    if skipped:
        print(f"[ocr_extractor] Skipped {skipped} malformed/unsupported result(s)")
    return results
