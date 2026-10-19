# Mobile pipeline: teammate setup

Start here after checking out the `mobile-exploration` branch. Keep the repository
layout intact: `mobile/src/database_storage.py` imports the sibling `database/`
folder even when uploads are disabled. Do not copy just `mobile/vision/`.

## What Git provides and what to obtain separately

The core vision explorer, generator, executor, tests, and Python database helpers
are versioned. Your own `mobile/.env`, emulator state, installed Android apps, and
custom UI model weights are not shared by Git. `mobile/models/android_ui.pt` is
ignored: get the exact weights used by the team privately for comparable results.
The default `yolov8n.pt` can run as a generic fallback, but is not trained on Android
controls and does not reproduce the custom model's detection quality.

`mobile/apps/` and `mobile/benchmarks/` are optional supporting resources; they must
be committed separately before teammates can use those files. Android Settings is
already installed on an Android emulator and needs no extra APK.

## 1. Install Python dependencies

Use Python 3.10+ (the development machine uses Python 3.12). From repository root
in PowerShell:

```powershell
git switch mobile-exploration
git pull --ff-only
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r mobile/requirements.txt
```

Dependencies use minimum versions, not an exact lockfile. A clean-machine emulator
run has not been validated. CPU execution is supported; first-time OCR/model
initialization may download files and take longer than later runs.

## 2. Prepare Android and Appium

Install Android Studio/SDK, an Android emulator image, a compatible JDK, and an
Appium-compatible Node.js version. Configure `ANDROID_HOME`, `JAVA_HOME`, and PATH
so `adb`, Java, and Appium work in the same terminal. Follow the upstream
[UiAutomator2 setup](https://github.com/appium/appium-uiautomator2-driver#requirements).
Install Appium and its Android driver if absent:

```powershell
npm install -g appium
appium driver install uiautomator2
appium driver doctor uiautomator2
adb devices
```

Boot one emulator and wait for Android to finish starting. `adb devices` should
show exactly the intended device with status `device`, not `offline`. In another
terminal, start the server and leave it running:

```powershell
appium --address 127.0.0.1 --port 4723
```

## 3. Configure mobile/.env

From repository root, copy the example only if no personal `.env` exists:

```powershell
if (-not (Test-Path mobile/.env)) { Copy-Item mobile/.env.example mobile/.env }
```

Edit `mobile/.env`. The vision runner reads this file, **not `database/.env`**.
Existing terminal environment variables take precedence; use a fresh terminal or
remove stale settings if changing `.env` appears to have no effect.

Choose one provider:

- Ollama (example default): install/start Ollama, then `ollama pull llama3.1`.
- Gemini: set `LLM_PROVIDER=gemini`, `GEMINI_API_KEY`, and an accessible
  `GEMINI_MODEL`. Startup checks a JSON response; quota is still needed throughout
  exploration. This is the provider used in the latest live run.

Other implemented providers are `groq` and `openai`; see `vision/llm_reasoner.py`
for their environment settings. Vercel AI Gateway and a Codex MCP reasoning route
are not implemented by this runner. Do not select `vercel` expecting it to work.

For matching UI detection, create `mobile/models/`, obtain the team's custom
weights, and set `MOBILE_YOLO_MODEL=models/android_ui.pt`. No weights are embedded
in this guide.

For Supabase, add the existing project's URL and server key privately and set
`DB_UPLOAD_ENABLED=true`. Start with `false` for a local smoke run. Do not create
a second Supabase project or rerun schema setup just to join the existing team.
See [database setup](DATABASE.md).

## 4. Verify without an emulator or paid model calls

From repository root, with the Python environment active:

```powershell
python -m unittest discover -s mobile/tests -v
python -m unittest discover -s database -p test_storage.py -v
python mobile/vision/explore_vision.py --help
```

These checks exercise mocked/local behavior, not the actual emulator or API.

## 5. Run a small live smoke test, then expand

From `mobile/`, with Appium and the emulator ready:

```powershell
python vision/explore_vision.py --max-steps 3 --app-package com.android.settings --app-activity .Settings --execute-generated
```

Check that the startup provider is the one you intended and a run directory is
created. Inspect `run_summary.json`, `vision_test_cases.json`, and
`test_execution/vision_execution_report.json` under `mobile/logs/vision/<run>/`.
A run with no replayable actions can legitimately generate no cases. Passing
assertions in the execution report, rather than the final `Done` message, determine
success. Some errors are caught during finalization, so terminal exit alone is not
sufficient to certify success.

Then expand and enable database saving:

```powershell
python vision/explore_vision.py --max-steps 40 --app-package com.android.settings --app-activity .Settings --execute-generated --app android-settings --comparison settings-quality-01
```

`--comparison` enables database integration. Expect `[database] ... uploaded` if
credentials and uploads are enabled. `saved locally` means no confirmed upload.
Check Supabase `public.runs` or `public.run_summary`, filtering by comparison ID.
From repository root, retry **all pending bundles** without rerunning tests:

```powershell
python database/manage.py retry --env mobile/.env
```

## Scenario quality and known limits

See [vision details](vision/README.md) for setup/cleanup, coverage tracking,
assertions, and `--requirements`. The example requirement file describes a
fictional profile editor: adapt it to real app requirements before using it.
Forty steps are an exploration budget, not a promise of ten cases.

The latest recorded live run stopped at step 10 on Gemini HTTP 429 and replayed
five cases (three passed, two failed). The loading-screen target `Checking info...`
was unstable. Loading/account flows and quota exhaustion remain known issues;
local unit tests do not establish that these are fixed. The runner can finalize
and replay previously collected actions after exploration fails. A completed
execution record means all generated cases received outcomes, not that all passed
or the full exploration budget was completed.

App relaunch resets navigation, not all data. Use an emulator with controlled
fixtures. Automatic exploration restores supported checkable controls; input and
radio scenarios need explicit requirement fixtures. Screenshots and replay
artifacts remain local rather than being uploaded with database JSON.
