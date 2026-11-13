# Web B visual perception

Playwright captures a page at 1280 x 900. ScreenParser YOLO detects UI elements,
Tesseract reads text, and the merge service combines them into a visual DOM.
The services bind to localhost and are intended for trusted local use.

| Component | Entry point | Default port |
| --- | --- | --- |
| Gateway | `gateway/app.js` | 5000 |
| YOLO | `services/yolo-service/detect.py` | 5001 |
| OCR | `services/ocr-service/ocr.py` | 5002 |
| Merge | `services/merge-service/merge.js` | 5003 |
| Screenshot capture | `services/browser-service/browser.js` | 5004 |

## Setup

Use Node.js 20+, Python 3.10+, and an installed Tesseract binary.

```sh
cd vision
npm ci
npx playwright install chromium
python -m pip install -r services/yolo-service/requirements.txt -r services/ocr-service/requirements.txt
```

Download the `best.pt` weights from [ScreenParser](https://huggingface.co/docling-project/ScreenParser)
and place them at `services/yolo-service/screenparser_best.pt` or set `YOLO_MODEL_PATH`
to the local weights file. Set `TESSERACT_CMD` to your installed executable path.
YOLO uses a 1280 inference size by default. OCR uses 2x grayscale preprocessing
and returns boxes in original screenshot coordinates.

In separate terminals from `vision/`, run `npm run start:yolo`, `npm run start:ocr`,
`npm run start:merge`, `npm run start:browser`, and `npm run start:gateway`.
The gateway exposes `GET /vision/health` and `POST /vision/process`. The latter accepts
a JSON `url`, `image_path`, or `image_b64`. Use trusted local inputs and approved sites.

## Tests and results

Run `npm test` and `python test/perceptionServices.test.py` from `vision/`.
The offline tests use mocked inference and require no model weights or browser session.

[Web B and Web C run snapshots](results/) contain stored benchmark outcomes.
