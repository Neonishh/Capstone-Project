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
The explorer now automatically selects the WDIO functional profile, using named
synthetic inputs and explicit assertions for Forms, login/sign-up, validation
boundaries, cancellation, persistence, carousel/scrolling, and the drag puzzle.
Completed workflows have `source.kind=app_profile`, distinct from observed/LLM-
selected regressions. A 40-step budget runs a subset; partial workflows and
unavailable targets are recorded in `behavior_review.json`. This demo shows
login/sign-up success alerts, not a real authenticated home screen. Use
`--behavior-profile off` for free exploration only. See [the vision guide](../vision/README.md).
