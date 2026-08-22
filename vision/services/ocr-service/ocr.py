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
    return jsonify({"status": "ok", "service": "ocr"})


@app.route("/extract", methods=["POST"])
def extract():
    data = request.get_json(force=True) or {}
    img = load_image(data)

    if img is None:
        return jsonify({"error": "Provide a readable image via image_path or image_b64"}), 400

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    tsv = pytesseract.image_to_data(
        thresh, output_type=pytesseract.Output.DICT, config="--psm 11"
    )

    words = []
    for i in range(len(tsv["text"])):
        text = tsv["text"][i].strip()
        conf = int(float(tsv["conf"][i]))
        if not text or conf < MIN_WORD_CONFIDENCE:
            continue
        words.append(
            {
                "text": text,
                "conf": conf,
                "bbox": {
                    "x": tsv["left"][i],
                    "y": tsv["top"][i],
                    "w": tsv["width"][i],
                    "h": tsv["height"][i],
                },
            }
        )

    return jsonify(
        {
            "word_count": len(words),
            "full_text": " ".join(w["text"] for w in words),
            "words": words,
        }
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("OCR_SERVICE_PORT", "5002")), debug=False)
