"""UI element detection service (Architecture B).

Uses docling-project/ScreenParser (YOLO11-Large, trained on 1.45M web
screenshots, 55 semantic UI classes) to detect interactive web UI elements
from screenshots. Replaces the previous COCO YOLOv8n which could not detect
web UI elements.

Configuration via environment variables:
  YOLO_MODEL_PATH - path to model weights (default: docling-project/ScreenParser)
  YOLO_CONF      - confidence threshold (default: 0.15)
  YOLO_IMGSZ     - inference image size (default: 640)
"""

import base64
import os
import time

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

import cv2
import numpy as np
from flask import Flask, jsonify, request
from ultralytics import YOLO

app = Flask(__name__)

MODEL_PATH = os.environ.get("YOLO_MODEL_PATH", os.path.join(BASE_DIR, "screenparser_best.pt"))
CONF_THRESHOLD = float(os.environ.get("YOLO_CONF", "0.15"))
IMGSZ = int(os.environ.get("YOLO_IMGSZ", "640"))

print(f"[yolo] Loading model: {MODEL_PATH} (conf={CONF_THRESHOLD}, imgsz={IMGSZ})")
model = YOLO(MODEL_PATH)
print(f"[yolo] Model loaded. Classes: {len(model.names)}")


def load_image(data):
    if data.get("image_path"):
        image_path = data["image_path"]
        if not os.path.exists(image_path):
            raise FileNotFoundError(image_path)
        return cv2.imread(image_path)
    if data.get("image_b64"):
        raw = base64.b64decode(data["image_b64"])
        buffer = np.frombuffer(raw, np.uint8)
        return cv2.imdecode(buffer, cv2.IMREAD_COLOR)
    return None


def draw_annotation(img, bbox, lines, color=(0, 220, 0)):
    """Draw one bounding box with multi-line label text onto img (in place)."""
    x1, y1, x2, y2 = [int(v) for v in bbox[:4]]
    cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)
    ty = max(y1 - 6, 14)
    for line in lines:
        if not line:
            continue
        # dark outline + white text so labels stay readable on any background
        cv2.putText(img, str(line), (x1 + 2, ty),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 3, cv2.LINE_AA)
        cv2.putText(img, str(line), (x1 + 2, ty),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)
        ty += 16
    return img


@app.route("/health")
def health():
    return jsonify({"status": "ok", "service": "yolo", "model": os.path.basename(MODEL_PATH)})


@app.route("/detect", methods=["POST"])
def detect():
    data = request.get_json(force=True) or {}
    try:
        img = load_image(data)
    except FileNotFoundError:
        return jsonify({"error": f"File not found: {data['image_path']}"}), 404

    if img is None:
        return jsonify({"error": "Provide a readable image via image_path or image_b64"}), 400

    start = time.time()
    results = model(img, conf=CONF_THRESHOLD, imgsz=IMGSZ, verbose=False)
    inference_ms = round((time.time() - start) * 1000)

    detections = []
    for result in results:
        for box in result.boxes:
            class_id = int(box.cls[0])
            label = model.names[class_id]
            confidence = float(box.conf[0])
            x1, y1, x2, y2 = [round(v, 1) for v in box.xyxy[0].tolist()]
            detections.append(
                {
                    "class_id": class_id,
                    "label": label,
                    "type": label.lower().replace(" ", "_"),
                    "confidence": round(confidence, 3),
                    "bbox": [x1, y1, x2, y2],
                }
            )

    height, width = results[0].orig_shape[:2]

    response = {
        "count": len(detections),
        "detections": detections,
        "image_size": {"width": width, "height": height},
        "inference_ms": inference_ms,
    }

    # Optional visual evidence: same detections rendered onto the image.
    if data.get("annotate"):
        annotated = img.copy()
        for det in detections:
            draw_annotation(
                annotated,
                det["bbox"],
                [det["label"], f"{det['confidence']:.2f}"],
            )
        ok, buf = cv2.imencode(".png", annotated)
        if ok:
            response["annotated_image_b64"] = base64.b64encode(buf).decode("ascii")

    return jsonify(response)


@app.route("/render_boxes", methods=["POST"])
def render_boxes():
    """Render arbitrary annotations onto an image.

    Body: { image_path | image_b64, annotations: [ { bbox: [x1,y1,x2,y2],
            lines: ["label", "0.82", ...], color: [B,G,R](optional) } ] }
    Returns: { annotated_image_b64 }
    Used for YOLO/OCR/merged visual-DOM evidence without touching originals.
    """
    data = request.get_json(force=True) or {}
    try:
        img = load_image(data)
    except FileNotFoundError:
        return jsonify({"error": f"File not found: {data.get('image_path')}"}), 404
    if img is None:
        return jsonify({"error": "Provide a readable image via image_path or image_b64"}), 400

    annotated = img.copy()
    count = 0
    for ann in data.get("annotations") or []:
        bbox = ann.get("bbox")
        if not bbox or len(bbox) < 4:
            continue
        color = ann.get("color") or (0, 220, 0)
        try:
            color = tuple(int(c) for c in color[:3])
        except (TypeError, ValueError):
            color = (0, 220, 0)
        draw_annotation(annotated, bbox, ann.get("lines") or [], color)
        count += 1

    ok, buf = cv2.imencode(".png", annotated)
    if not ok:
        return jsonify({"error": "Failed to encode annotated image"}), 500
    return jsonify({
        "annotated_image_b64": base64.b64encode(buf).decode("ascii"),
        "rendered": count,
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("YOLO_SERVICE_PORT", "5001")), debug=False)



