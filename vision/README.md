# Vision Architecture (Architecture B)

YOLO + OCR based UI understanding for automated web test case generation.

## Pipeline

```
URL
  |
  v
Playwright screenshot  (services/browser-service)
  |
  +--> ScreenParser UI detection (services/yolo-service, Python + ultralytics)
  |        |
  |        v
  |    bounding boxes + 55 semantic UI classes
  |
  +--> OCR text boxes   (services/ocr-service, Python + Tesseract)
           |
           v
       Merge into visual DOM  (services/merge-service)
           |
           v
       LLM generates coordinate-based workflow test cases  (src/llm.js -> Groq API)
           |
           v
       storage/outputs/<run_id>_test_cases... + permanent executor (src/executeTests.js)
```

## Folder layout

```
vision/
├── gateway/          Express gateway orchestrating all services
├── services/
│   ├── browser-service/  Playwright screenshot capture (Node)
│   ├── yolo-service/     YOLOv8 object detection (Python)
│   ├── ocr-service/      Tesseract OCR word extraction (Python)
│   └── merge-service/    YOLO + OCR merge into visual DOM (Node)
├── src/
│   ├── llm.js            Vision-specific LLM client (Groq)
│   ├── visualDom.js      Prompt builder from visual DOM
│   └── testGenerator.js  Test case generation orchestration
│   └── executeTests.js   Coordinate-based test executor
├── runVision.js          One-shot demo entry point
├── package.json
├── .env.example
└── README.md
```

This folder is completely independent of Architecture A (`web/`).
Both can be demonstrated separately.

## Detector: ScreenParser (not COCO YOLO)

UI detection uses **`docling-project/ScreenParser`** — a YOLO11-Large model
fine-tuned on ~1.45 million real web/mobile screenshots with **55 semantic UI
classes** (Button, Link, Text Input, Checkbox, Radiobox, Select, Table, ...).
The original COCO-pretrained YOLOv8n was removed: its everyday-object classes
do not map to web UI elements.

Model weights are gitignored. Install locally:

```bash
python -c "from huggingface_hub import hf_hub_download; print(hf_hub_download('docling-project/ScreenParser','best.pt'))"
# copy the downloaded best.pt to:
#   vision/services/yolo-service/screenparser_best.pt
```

Config in `.env`: `YOLO_MODEL_PATH=screenparser_best.pt`, `YOLO_CONF=0.15`,
`YOLO_IMGSZ=640`.

## Prerequisites

1. Node.js >= 18
2. Python 3.10+ with pip (`pip install -r services/yolo-service/requirements.txt`
   and `services/ocr-service/requirements.txt`)
3. Tesseract OCR at `C:\Program Files\Tesseract-OCR\tesseract.exe` (or set `TESSERACT_CMD`)
4. Playwright Chromium: `npx playwright install chromium`
5. A valid `GROQ_API_KEY` in `.env` (copy from `.env.example`)

## Setup

```bash
cd vision
npm install
pip install -r services/yolo-service/requirements.txt
pip install -r services/ocr-service/requirements.txt
copy .env.example .env
# edit .env and add your GROQ_API_KEY
```

## Run demo

One-shot test generation (existing mode — unchanged):

```bash
node runVision.js https://demoqa.com
```

Autonomous multi-page visual exploration (new mode):

```bash
node runVision.js --explore https://demoqa.com
# optional overrides:
#   EXPLORE_MAX_STEPS=25 EXPLORE_MAX_STATES=12 EXPLORE_MAX_DEPTH=8
#   EXPLORE_MAX_ACTIONS_PER_STATE=4 node runVision.js --explore <url>
```

The explorer starts from one URL, then repeatedly: screenshot -> YOLO+OCR ->
visual DOM -> LLM picks ONE action from the CURRENT state's detected elements ->
execute -> post-action screenshot -> re-detect -> state fingerprint comparison.
It navigates across real pages, goes back from repeated states, records the full
history, and finally converts the DISCOVERED workflows into replayable test cases
(`storage/outputs/test_cases_<run_id>_exploration.json`, executable with
`src/executeTests.js`).

Outputs per run:
- `storage/screenshots/<run_id>/state_NNN_*.png` — screenshot + merged evidence per state
- `storage/outputs/<run_id>_exploration_history.json` — full states + transitions
- `storage/outputs/<run_id>_exploration_result.json` — summary
- `storage/outputs/test_cases_<run_id>_exploration.json` — discovered workflows

Known exploration limitations: ScreenParser can misclassify banner/footer text as
links (pseudo-links get tried and honestly recorded); dynamic/animated regions can
change fingerprints between captures; coordinate replay depends on pages looking
the same as during exploration; some interactions (file choosers, iframes, native
dialogs) are not supported.

## Visual evidence & screenshot traceability

Every pipeline run creates an evidence folder that never overwrites previous runs:

```
vision/storage/screenshots/<run_id>/
├── state_001_initial.png        original page screenshot (untouched)
├── state_001_yolo.png           YOLO detections: boxes + class + confidence
├── state_001_ocr.png            OCR words: text + confidence per box
├── state_001_merged.png         merged visual DOM: YOLO class + element id + OCR text
├── state_NNN_before_TCxx.png    executor: page state before a test
├── state_NNN_after_click.png    executor: page state after each click/fill/navigate
└── state_NNN_failure_TCxx.png   executor: final failed state (never cleaned up)
```

- `<run_id>` is `run_<timestamp>` for pipeline runs (`runVision.js` / gateway) and
  `exec_<timestamp>` if the executor runs standalone.
- The visual DOM JSON references the initial/YOLO/OCR/merged images via its
  `screenshots` field and carries the `run_id`; execution results reference each
  test's `before_screenshot`, per-step `after_screenshot`, and `failure_screenshot`.
- Annotated images are generated from existing detection data by the YOLO service
  (`/render_boxes`) — no extra detector or dependency.

## Execute generated tests

Re-run saved test cases against their source URL without regenerating them
(no LLM call, no services needed):

```bash
cd vision
node src/executeTests.js storage/outputs/test_cases_<name>.json https://demoqa.com
# optional third arg: custom report path (default storage/outputs/execution_results.json)
```

Each test navigates to the base URL, executes its steps via coordinate-based
Playwright actions (`click`/`fill`/`navigate`), and verifies outcomes using
URL-change and body-text heuristics. A summary with per-test status,
failure reasons, executed steps and timings is written to
`storage/outputs/execution_results.json`.


Or start each service manually in separate terminals:

```bash
npm run start:browser
npm run start:yolo
npm run start:ocr
npm run start:merge
npm run start:gateway
```

Then POST to the gateway:

```bash
curl -X POST http://127.0.0.1:5000/vision/generate-tests ^
     -H "Content-Type: application/json" ^
     -d "{\"url\": \"https://demoqa.com\"}"
```

## Endpoints

| Endpoint                  | Method | Description                                  |
|---------------------------|--------|----------------------------------------------|
| `/vision/health`          | GET    | Health check for all downstream services     |
| `/vision/process`         | POST   | URL/image -> visual DOM only                 |
| `/vision/generate-tests`  | POST   | URL/image -> visual DOM -> LLM test cases    |

Body accepts `{ "url": "..." }`, `{ "image_path": "..." }`,
or `{ "image_b64": "..." }`.

## Execution output & what the pass rate means

`storage/outputs/<run_id>_execution_results*.json` contains per-test results
with a `verification` field describing exactly which evidence backed each
verdict:

| verification method | meaning |
|---|---|
| `url_change` | page URL changed (navigation assertions) |
| `input_value` | a text field provably holds the typed value |
| `checked_state` | a radio/checkbox toggled after the click |
| `scroll_position` | window scroll position changed |
| `body_text_fallback` | weak check: body renders non-trivially — flagged as a warning, not strong evidence |
| `none` / `skipped` | assertion could not be verified (test already failed) |

The reported **pass rate is an execution+verification success rate**, NOT overall
system accuracy. Detector quality, OCR quality and action-selection quality are
reported separately (`element_count`, `ocr_words_found`, `states_observed`,
per-step signals), so a single PASS number is never presented as "accuracy".
