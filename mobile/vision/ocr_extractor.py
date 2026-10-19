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
from functools import lru_cache


@lru_cache(maxsize=4)
def _reader(languages):
    import easyocr
    import torch
    import os
    torch.set_num_threads(max(1, int(os.environ.get("MOBILE_TORCH_THREADS", "4"))))
    return easyocr.Reader(list(languages), gpu=False, verbose=False)


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
        import cv2
    except ImportError:
        raise RuntimeError(
            "[ocr_extractor] EasyOCR/OpenCV dependency missing. "
            "Run: pip install easyocr opencv-python"
        )

    if languages is None:
        languages = ["en"]

    if not Path(image_path).exists():
        raise FileNotFoundError(f"[ocr_extractor] Image not found: {image_path}")

    # Read and convert explicitly instead of passing a filename. EasyOCR's
    # filename path can leave a 3-channel image in its grayscale recognition
    # path after another OpenCV-based detector has run in the same process.
    image = cv2.imread(str(image_path), cv2.IMREAD_UNCHANGED)
    if image is None:
        raise ValueError(f"[ocr_extractor] Could not read image: {image_path}")
    if image.ndim == 2:
        gray = image
    elif image.ndim == 3 and image.shape[2] == 4:
        gray = cv2.cvtColor(image, cv2.COLOR_BGRA2GRAY)
    elif image.ndim == 3 and image.shape[2] == 3:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    else:
        raise ValueError(
            f"[ocr_extractor] Unsupported screenshot shape: {image.shape}"
        )

    # gpu=False works everywhere; set gpu=True if CUDA is available for speed
    reader  = _reader(tuple(languages))
    raw     = reader.readtext(gray)

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
