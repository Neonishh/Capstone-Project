"""UI element detection service (Architecture B).

Uses docling-project/ScreenParser (YOLO11-Large, trained on 1.45M web
screenshots, 55 semantic UI classes) to detect interactive web UI elements
from screenshots. Replaces the previous COCO YOLOv8n which could not detect
web UI elements.

Configuration via environment variables:
  YOLO_MODEL_PATH - path to model weights (default: screenparser_best.pt beside this file)
  YOLO_CONF      - confidence threshold (default: 0.15)
  YOLO_IMGSZ     - inference image size (default: 1280, ScreenParser training size)
"""

import base64
import os
import time

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Keep generated Ultralytics settings out of the repository root. Create the
# directory before importing Ultralytics so its writable-directory fallback
# does not select the current working directory instead.
_config_dir = os.environ.get("YOLO_CONFIG_DIR") or os.path.abspath(
    os.path.join(BASE_DIR, "..", "..", "..", "logs", "test-runs", "ultralytics")
)
os.makedirs(_config_dir, exist_ok=True)
os.environ["YOLO_CONFIG_DIR"] = _config_dir

import cv2
import numpy as np
from flask import Flask, jsonify, request
from ultralytics import YOLO

app = Flask(__name__)

MODEL_PATH = os.environ.get("YOLO_MODEL_PATH", os.path.join(BASE_DIR, "screenparser_best.pt"))
CONF_THRESHOLD = float(os.environ.get("YOLO_CONF", "0.15"))
IMGSZ = int(os.environ.get("YOLO_IMGSZ", "1280"))

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
    return jsonify({"status": "ok", "service": "yolo", "model": os.path.basename(MODEL_PATH),
                    "inference_size": IMGSZ, "confidence": CONF_THRESHOLD})


@app.route("/detect", methods=["POST"])
def detect():
    data = request.get_json(force=True) or {}
    try:
        img = load_image(data)
    except FileNotFoundError:
        return jsonify({"error": f"File not found: {data['image_path']}"}), 404

    if img is None:
        return jsonify({"error": "Provide a readable image via image_path or image_b64"}), 400

    original_height, original_width = img.shape[:2]

    requested_conf = data.get('conf', CONF_THRESHOLD)
    try:
        conf_threshold = float(requested_conf)
        if not 0.0 <= conf_threshold <= 1.0:
            conf_threshold = CONF_THRESHOLD
    except (TypeError, ValueError):
        conf_threshold = CONF_THRESHOLD

    # M3 Fix A: optional top-band crop + upscale for faint empty inputs.
    # topband=true crops y0..35% and upscales 2x (override via topband_scale);
    # detection boxes are mapped back to ORIGINAL frame coordinates.
    topband_scale = 1.0
    if data.get('topband'):
        try:
            topband_scale = float(data.get('topband_scale', 2))
            if not 1.0 <= topband_scale <= 4.0:
                topband_scale = 2.0
        except (TypeError, ValueError):
            topband_scale = 2.0
        orig_h, orig_w = img.shape[:2]
        band_h = max(1, int(orig_h * 0.35))
        img = cv2.resize(img[0:band_h, 0:orig_w], None,
                         fx=topband_scale, fy=topband_scale,
                         interpolation=cv2.INTER_CUBIC)

    start = time.time()
    results = model(img, conf=conf_threshold, imgsz=IMGSZ, verbose=False)
    inference_ms = round((time.time() - start) * 1000)

    detections = []
    for result in results:
        for box in result.boxes:
            class_id = int(box.cls[0])
            label = model.names[class_id]
            confidence = float(box.conf[0])
            x1, y1, x2, y2 = [round(v, 1) for v in box.xyxy[0].tolist()]
            if topband_scale != 1.0:
                # Map back to the original full-frame coordinates.
                x1, y1, x2, y2 = [round(v / topband_scale, 1) for v in (x1, y1, x2, y2)]
            detections.append(
                {
                    "class_id": class_id,
                    "label": label,
                    "type": label.lower().replace(" ", "_"),
                    "confidence": round(confidence, 3),
                    "bbox": [x1, y1, x2, y2],
                }
            )

    height, width = original_height, original_width
    if topband_scale != 1.0:
        # orig_shape is the cropped/upscaled frame; report true dimensions.
        height, width = original_height, original_width

    response = {
        "count": len(detections),
        "detections": detections,
        "image_size": {"width": width, "height": height},
        "inference_ms": inference_ms,
        "topband": topband_scale != 1.0,
        "inference_size": IMGSZ,
    }

    # Optional visual evidence: same detections rendered onto the image.
    # (Skipped for topband crops: boxes are original-frame, image is cropped.)
    if data.get("annotate") and topband_scale == 1.0:
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
    app.run(host="127.0.0.1", port=int(os.environ.get("YOLO_SERVICE_PORT", "5001")), debug=False)
