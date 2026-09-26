# Mobile Architecture B — Vision Pipeline

Produces a structured JSON describing the current Android screen using
screenshots, YOLO object detection, and OCR text extraction.

No LLM reasoning. No test generation. Vision pipeline only.

---

## Folder Structure

```
mobile/
├── vision/
│   ├── __init__.py
│   ├── screenshot_capture.py   # Module 1 — capture screen via Appium
│   ├── yolo_detector.py        # Module 2 — YOLO UI component detection
│   ├── ocr_extractor.py        # Module 3 — EasyOCR text extraction
│   ├── vision_merger.py        # Module 4 — merge YOLO + OCR into JSON
│   ├── explore_vision.py       # Runner — orchestrates 5 steps
│   └── README.md               # this file
└── logs/
    └── vision/
        ├── screenshots/        # screen_01_timestamp.png ...
        └── json/               # vision_screen_01.json ...
```

---

## Dependencies

```bash
pip install ultralytics    # YOLOv8
pip install easyocr        # OCR
pip install opencv-python  # required by both ultralytics and easyocr
```

---

## Module Descriptions

### Module 1 — screenshot_capture.py
Captures the current Android screen via `driver.save_screenshot()`.
Saves as `screen_01_YYYYMMDD_HHMMSS.png` in `logs/vision/screenshots/`.
Returns the file path for downstream modules.

### Module 2 — yolo_detector.py
Loads YOLOv8n (auto-downloaded on first run) and runs inference on the screenshot.
Maps COCO class names to UI component types: button, text_field, icon, image, etc.
Returns a list of `{ class, bbox, confidence }` dicts.
Replace `yolov8n.pt` with a UI-trained model for better accuracy.

### Module 3 — ocr_extractor.py
Runs EasyOCR on the screenshot to extract all visible text.
Converts EasyOCR's 4-corner polygon bboxes to `[x1, y1, x2, y2]` format.
Returns a list of `{ text, bbox }` dicts.

### Module 4 — vision_merger.py
Matches each YOLO detection to overlapping OCR text regions using centre-point
containment. Builds a unified `elements` list combining type, text, bbox, and
confidence. Saves as `vision_screen_01.json` in `logs/vision/json/`.

---

## Output Format

Each `vision_screen_XX.json`:

```json
{
  "step": 1,
  "screenshot": "logs/vision/screenshots/screen_01_20260901_140000.png",
  "screen": "Login",
  "elements": [
    {
      "type": "button",
      "text": "Login",
      "bbox": [120, 500, 350, 580],
      "confidence": 0.94
    },
    {
      "type": "text_field",
      "text": "Email",
      "bbox": [120, 400, 350, 460],
      "confidence": 0.87
    },
    {
      "type": "text",
      "text": "Forgot Password?",
      "bbox": [130, 600, 320, 630],
      "confidence": null
    }
  ]
}
```

---

## How to Run

**Prerequisites:**
- Android emulator running
- Appium server running (`appium`)
- App installed on emulator

**Install dependencies:**
```bash
cd mobile
source venv/bin/activate
pip install ultralytics easyocr opencv-python
```

**Run vision pipeline (Settings app):**
```bash
python vision/explore_vision.py
```

**Run on Sauce Labs demo app:**
```bash
python vision/explore_vision.py \
  --app-package com.saucelabs.mydemoapp.android \
  --app-activity .view.activities.SplashActivity
```

---

## Notes

- YOLO model (`yolov8n.pt`) is auto-downloaded ~6MB on first run
- EasyOCR language models are downloaded on first run (~100MB)
- For better UI detection, fine-tune YOLO on a mobile UI dataset
- GPU not required — both YOLO and EasyOCR run on CPU
