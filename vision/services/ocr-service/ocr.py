"""OCR extraction service (Architecture B).

Reads words and bounding boxes from a screenshot using Tesseract.
The Tesseract path can be overridden via TESSERACT_CMD.
"""

import base64
import os

import cv2
import numpy as np
import pytesseract
from flask import Flask, jsonify, request

app = Flask(__name__)

pytesseract.pytesseract.tesseract_cmd = os.environ.get(
    "TESSERACT_CMD", r"C:\Program Files\Tesseract-OCR\tesseract.exe"
)

MIN_WORD_CONFIDENCE = int(os.environ.get("OCR_MIN_CONF", "40"))
DEFAULT_SCALE = float(os.environ.get("OCR_SCALE", "2"))
DEFAULT_PREPROCESS = os.environ.get("OCR_PREPROCESS", "gray")


def recognize_words(img, scale=DEFAULT_SCALE, preprocess=DEFAULT_PREPROCESS):
    """Improve small UI text without changing the caller's pixel coordinates."""
    scale = float(scale)
    if not np.isfinite(scale) or not 1 <= scale <= 3:
        raise ValueError("scale must be between 1 and 3")
    if preprocess not in ("gray", "otsu"):
        raise ValueError("preprocess must be gray or otsu")
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    if scale != 1:
        gray = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    if preprocess == "otsu":
        gray = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
    tsv = pytesseract.image_to_data(
        gray, output_type=pytesseract.Output.DICT, config="--psm 11"
    )
    words = []
    for i, raw in enumerate(tsv["text"]):
        text = raw.strip()
        conf = float(tsv["conf"][i])
        if not text or conf < MIN_WORD_CONFIDENCE:
            continue
        words.append({
            "text": text, "conf": int(conf),
            "bbox": {"x": round(tsv["left"][i] / scale),
                     "y": round(tsv["top"][i] / scale),
                     "w": max(1, round(tsv["width"][i] / scale)),
                     "h": max(1, round(tsv["height"][i] / scale))},
        })
    return words


def load_image(data):
    if data.get("image_path"):
        return cv2.imread(data["image_path"])
    if data.get("image_b64"):
        raw = base64.b64decode(data["image_b64"])
        buffer = np.frombuffer(raw, np.uint8)
        return cv2.imdecode(buffer, cv2.IMREAD_COLOR)
    return None


@app.route("/health")
def health():
    return jsonify({"status": "ok", "service": "ocr", "engine": "tesseract",
                    "scale": DEFAULT_SCALE, "preprocess": DEFAULT_PREPROCESS})


@app.route("/extract", methods=["POST"])
def extract():
    data = request.get_json(force=True) or {}
    img = load_image(data)

    if img is None:
        return jsonify({"error": "Provide a readable image via image_path or image_b64"}), 400

    try:
        scale = float(data.get("scale", DEFAULT_SCALE))
        preprocess = data.get("preprocess", DEFAULT_PREPROCESS)
        words = recognize_words(img, scale, preprocess)
    except (ValueError, TypeError):
        return jsonify({"error": "Invalid OCR scale/preprocess"}), 400

    return jsonify(
        {
            "word_count": len(words),
            "full_text": " ".join(w["text"] for w in words),
            "words": words,
            "preprocessing": {"scale": scale, "mode": preprocess, "coordinates": "original_image"},
        }
    )


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("OCR_SERVICE_PORT", "5002")), debug=False)
