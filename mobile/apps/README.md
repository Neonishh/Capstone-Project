# WebdriverIO demo app

Installed release: v2.2.0, Android package `com.wdiodemoapp`, activity `.MainActivity`.
The downloaded APK is ignored by Git. `wdio-release.json` records its source and SHA-256.

With the emulator and Appium running, execute from `mobile/`:

```powershell
python vision/explore_vision.py --app-package com.wdiodemoapp --app-activity .MainActivity --execute-generated
python benchmarks/wdio_reference_smoke.py
```

The reference smoke script is a Python adaptation of selected upstream WebdriverIO
behaviors (input echo, switch, dropdown, login). It is not the full upstream suite
and is not AI-generated. Source links are recorded in its report. These are pilot
checks, not a completed coverage benchmark.

Reports: `mobile/logs/vision/<run>/` and `mobile/logs/benchmarks/wdio_reference_<run>/`.
The current generator redacts typed values and therefore stops generating replay
paths when it encounters a typed step. Synthetic test-data fixtures must be added
before claiming generated coverage of login or form-submission workflows.
