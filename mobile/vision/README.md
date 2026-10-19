# Mobile Architecture B — Vision Pipeline

New teammate? Start with [mobile setup](../README.md) for installation, credentials, model weights, and smoke testing.

Produces a structured JSON describing the current Android screen using
screenshots, YOLO object detection, and OCR text extraction.

Uses accessibility, OCR, YOLO, and an LLM-driven controller to explore screens.

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
│   ├── coordinate_mapper.py    # Map screenshot bounds to Appium tap coordinates; save tap overlays
│   ├── action_verification.py  # Compare before/after screen and control evidence
│   ├── target_matcher.py       # Re-find recorded targets on the current screen
│   ├── vision_test_executor.py # Re-perceive, resolve, execute, and verify JSON cases
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
Saves as `screen_01_YYYYMMDD_HHMMSS.png` in the current run's
`logs/vision/<run_id>/screenshots/` directory. Each pipeline invocation uses
a unique UTC timestamp run directory, keeping prior run outputs intact.
Returns the file path for downstream modules.

### Module 2 — yolo_detector.py
Loads the model selected by `MOBILE_YOLO_MODEL` (default `yolov8n.pt`) and
runs inference on the screenshot. The model is cached for the process lifetime.
Known mobile UI labels are normalized to common types; other class labels are
preserved. Use Android UI-trained weights for useful control detections. The
default COCO model detects everyday objects and is only a fallback.

#### Configure mobile UI weights

Place an Ultralytics-compatible weights file in `mobile/models/`, for example
`mobile/models/android_ui.pt`, then set these variables in `mobile/.env`:

```dotenv
MOBILE_YOLO_MODEL=models/android_ui.pt
MOBILE_YOLO_CONFIDENCE=0.25
```

`MOBILE_YOLO_MODEL` can also be an absolute path. Relative paths are resolved
from the current directory first, then from `mobile/`. The confidence setting
is optional and defaults to `0.25`. Class names from your model should reflect
the annotations used for training; common names such as `Button`, `EditText`,
`TextView`, `CheckBox`, `Switch`, and `ImageView` are normalized automatically.

From the `mobile/` directory, inspect a saved screenshot with the configured
model (or pass a one-off model override):

```bash
python vision/check_vision_models.py logs/vision/<run_id>/screenshots/<screenshot>.png
python vision/check_vision_models.py logs/vision/<run_id>/screenshots/<screenshot>.png --model models/android_ui.pt
```

The same `.env` setting is used by both exploration and test replay:

```bash
python vision/explore_vision.py
python vision/vision_test_executor.py logs/path/to/vision_test_cases.json
```

### Module 3 — ocr_extractor.py
Runs EasyOCR on the screenshot to extract visible text. Handles standard
quadrilateral results and axis-aligned boxes, skipping malformed records.
Returns a list of `{ text, bbox }` dicts.

Accessibility extraction supplies native labels, bounds, clickability, and
checked state. Labels inside clickable rows inherit the row's tap bounds.
The reasoner can tap only controls marked clickable/checkable and can type
only into controls identified as editable. Memory entries include separate
YOLO/OCR/accessibility counts and post-action screen/checkable-state changes.

### Tap mapping and action evidence

`coordinate_mapper.py` maps the center of the selected screenshot bounding box
to Appium coordinates. It prefers `mobile: deviceScreenInfo` and falls back
to Appium's window size. Each tap stores both coordinate pairs, scale factors,
dimension source, offsets, and an aspect-ratio mismatch flag in the memory log.
Set `TAP_X_OFFSET_PX` or `TAP_Y_OFFSET_PX` only when the saved overlay confirms
a consistent offset. A mismatch is reported for inspection; it is not silently
corrected because the screenshot and tap area alone do not identify system-bar
insets reliably.

For each tap/type, an overlay is saved under the run's `debug/` directory:
the intended control box is green and the screenshot-space tap point is red.
`action_verification.py` compares before/after screenshots (ignoring the top
status bar), visible accessibility text, inferred screen title, and checkable
states. The result is written as `execution.verification` and
`execution.effect_detected` in `vision_memory_log.json`. This is evidence that
the UI changed, not a guarantee that the intended business behavior succeeded;
test execution should still assert the expected screen or control state.

`target_matcher.py` is used by the test executor to find each control again on
the live screen using its recorded text, type, and normalized position. It only
accepts controls that Android marks clickable/checkable, and editable fields
that Android marks editable. Ambiguous or missing matches fail instead of
reusing stale coordinates. `vision_test_executor.py` then maps the newly found
box, runs the action, and checks the result. It accepts a JSON array of cases
with `id` (or `test_case_id`), `objective` (or `title`), `steps`, and a target
object such as `{"type":"accessibility","text":"Wi-Fi","norm_center":[0.5,0.4]}`.
It also accepts the Architecture A mobile schema where a step provides a
`resource_id` directly.

### Module 4 — vision_merger.py
Matches each YOLO detection to overlapping OCR text regions using centre-point
containment. Builds a unified `elements` list combining type, text, bbox, and
confidence. Saves as `vision_screen_01.json` in the current run's
`logs/vision/<run_id>/json/` directory. The run's memory log is stored beside
the `screenshots/` and `json/` directories.

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

The explorer now writes `vision_test_cases.json` from successfully executed,
verified interactive actions. If the LLM call fails, it tries an untried
clickable accessibility control; it does not turn that recovery action into a
case unless the action succeeds and changes the UI. To also replay the cases
and save the execution report in the same run folder, use:

```bash
python vision/explore_vision.py --execute-generated
```

Each run is self-contained:

```
logs/vision/<run_id>/
├── screenshots/                   # before/after screenshots
├── json/                          # vision_screen_XX.json observations
├── debug/                         # tap overlays
├── vision_memory_log.json         # actions, targets, and verification evidence
├── vision_test_cases.json         # generated replayable cases (may be empty
│                                  # when no verified interactive action occurred)
├── run_summary.json               # artifact index and run counts
└── test_execution/                # present with --execute-generated or replay
    ├── cases/                     # per-case screenshots, JSON, and overlays
    └── vision_execution_report.json
```

Replay generated vision test cases later (from the mobile directory):

```bash
python vision/vision_test_executor.py logs/path/to/vision_test_cases.json
```

For the existing mobile cases, the command from `mobile/` is:

```bash
python vision/vision_test_executor.py logs/mobile_test_cases.json
```

Replay evidence is written under `test_execution/` beside the test-case file.
It contains per-step screenshots and merged JSON, tap overlays, and
`vision_execution_report.json`. App restart alone may not restore all app data
to an identical initial state, so reset/setup preconditions still need to be
controlled for fair comparisons.

**Run on Sauce Labs demo app:**
```bash
python vision/explore_vision.py \
  --app-package com.saucelabs.mydemoapp.android \
  --app-activity .view.activities.SplashActivity
```

---

## Notes

- The default `yolov8n.pt` may be downloaded by Ultralytics on first run; custom
  model paths must point to an existing weights file.
- EasyOCR language models are downloaded on first run (~100MB)
- For better UI detection, train or fine-tune YOLO on annotated Android app
  screenshots, then set `MOBILE_YOLO_MODEL` to the resulting weights file.
- GPU not required — both YOLO and EasyOCR run on CPU
- The current generic COCO YOLO weights are not trained to recognize Android
  controls. Treat YOLO counts as experimental until UI-trained weights are used.
- OCR, visual-difference, and screen-title checks are heuristic and can produce
  misses or unrelated changes. Review tap overlays and verification evidence.


## Reproducible Gemini replay

Set `LLM_PROVIDER=gemini`, `GEMINI_API_KEY` and `GEMINI_MODEL` in
`mobile/.env`. Gemini calls use the shared standard-library REST client, not
`google.generativeai`. The runner verifies a small JSON response before connecting
to Appium. Model/credential/quota errors stop exploration rather than silently
producing heuristic cases. `gemini-2.5-flash` was verified with this account;
model availability and free-tier quotas can change.

From `mobile/`, with the emulator and Appium running:

```powershell
python vision/explore_vision.py --app-package com.android.settings --app-activity .Settings --execute-generated
```

Exploration and each replay explicitly launch the supplied activity with a fresh
task. This resets navigation, not application data or system settings. Tests that
mutate persistent data still require fixtures appropriate to the app.

Generated cases carry their launch precondition and check recorded destination
texts and activity. These are regression postconditions derived from observed
behavior, not proof of requirements correctness. LLM-failure fallback actions are
excluded, and an unrecorded/failed transition ends the replayable path. A run may
legitimately produce fewer cases than exploration steps. Historical cases generated
from a different starting screen should be regenerated.

See `test_execution/vision_execution_report.json` for actual outcomes. JSON screen
captures, screenshots and debug tap overlays stay inside the timestamped run folder.
Add `--app android-settings --comparison settings-01` for shared database saving.


## Coverage and scenario quality

Exploration defaults to 30 steps. Override the budget from `mobile/`:

```powershell
python vision/explore_vision.py --max-steps 40 --app-package com.android.settings --app-activity .Settings --execute-generated --app android-settings --comparison settings-quality-01
```

`coverage.json` records distinct screen/action counts and screen visits. Actions are
tracked per screen rather than globally by label. Repeated actions are replaced
with untried controls; exhausted screens trigger scrolling or back navigation.
A step budget is not a minimum case count: only evidenced cases are generated.

Generated cases contain `setup`, a focused `steps` sequence, `cleanup`, and an
explicit `verification`. The generator remembers shortest observed clean navigation
paths and deduplicates identical screen/action/outcome combinations. These paths
can still share necessary navigation. Unknown or mutated paths are excluded until
a known clean screen is reached. Historic logs without screen identities have less
path-shortening information; regenerate exploration to use coverage fully.

Toggle assertions check the uniquely identified control's actual `checked` value,
not its label or a screenshot difference. Setup establishes the recorded baseline;
cleanup restores it even if execution fails. Cleanup failure fails the case and is
reported separately. Exploration also restores checkable controls immediately and
relaunches navigation. Radio choices require explicit requirement fixtures because
restoring the previous selection requires identifying the radio group. Arbitrary
application data is not reset by relaunch; declare its setup and cleanup explicitly.

Requirement scenarios are supplied with `--requirements path/to/requirements.json`.
See `requirements.example.json` for valid, invalid, boundary, cancellation, and
persistence examples. **This example describes a fictional profile editor**: replace
its targets, values, limits, baseline, and expected text with your app's actual
requirements before running it. Empty setup/cleanup arrays are allowed only when
no fixture work is needed. Keep test values synthetic; scenario files and replay
artifacts can include the supplied values.

Each requirement has an `id` and `scenarios` array. Each scenario needs its own `id`,
`category`, `setup`, `steps`, `cleanup`, and `verification`. Supported actions are
`tap`, `type`, `swipe`, `back`, `relaunch`, and `set_checked`. A `type` step can use
`clear: true` to replace existing input, including with an empty value. Use
`expect_change: false` for actions that may validly leave the UI unchanged; final
assertions still run. `relaunch` resets navigation without clearing data, allowing
persistence scenarios. Cleanup starts from a fresh launch, so include navigation
in cleanup as needed.

Strong verification forms:

- `{"type":"postcondition","texts":["Name is required"],"activity":".MainActivity"}`:
  every text must match exactly after whitespace/case normalization; activity is optional.
- `{"type":"control_state","target":{"text":"Wi-Fi","resource_id":"your:id/switch"},"checked":true}`:
  exactly one matching checkable control must have the expected boolean state.
- `{"type":"all","conditions":[...strong verification objects...]}`: all checks must pass.

Requirements reject missing or weak change-only oracles. The generator does not
invent valid/invalid input rules or business expectations from observed behavior.
Navigation cases remain observed regression checks, not independent proof of
requirements correctness. Existing legacy change-based oracle types are retained
for old files; cases with missing or unsupported oracles now fail.

Automatic exploration defers text-entry mutations to explicit requirement scenarios,
where synthetic inputs and cleanup can be specified. Radio group scenarios also
need an explicit fixture for their previous selection.
