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
    for (bbox_points, text, confidence) in raw:
        text = text.strip()
        if not text:
            continue

        # EasyOCR returns 4 corner points — convert to [x1, y1, x2, y2]
        xs = [int(p[0]) for p in bbox_points]
        ys = [int(p[1]) for p in bbox_points]
        x1, y1, x2, y2 = min(xs), min(ys), max(xs), max(ys)

        results.append({
            "text": text,
            "bbox": [x1, y1, x2, y2],
        })

    print(f"[ocr_extractor] {len(results)} text region(s) found in {Path(image_path).name}")
    return results
