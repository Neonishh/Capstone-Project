import sys
import json
import cv2
from ultralytics import YOLO
import pytesseract

def run_yolo(screenshot_path):
    model = YOLO('yolov8n.pt')  # Use yolov8n.pt or your custom model
    results = model(screenshot_path)
    detections = []
    for r in results:
        for box in r.boxes:
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            label = model.names[int(box.cls[0])]
            conf = float(box.conf[0])
            detections.append({"label": label, "bbox": [x1, y1, x2, y2], "confidence": conf})
    return detections

def run_ocr(screenshot_path):
    img = cv2.imread(screenshot_path)
    data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT)
    results = []
    for i in range(len(data['text'])):
        if int(data['conf'][i]) > 60 and data['text'][i].strip():
            x, y, w, h = data['left'][i], data['top'][i], data['width'][i], data['height'][i]
            results.append({"text": data['text'][i], "bbox": [x, y, x + w, y + h]})
    return results

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No screenshot path provided"}))
        sys.exit(1)
    screenshot_path = sys.argv[1]
    yolo_results = run_yolo(screenshot_path)
    ocr_results = run_ocr(screenshot_path)
    print(json.dumps({"yolo": yolo_results, "ocr": ocr_results}))

if __name__ == "__main__":
    main()
