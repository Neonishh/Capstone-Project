# Functional exploration changes — October 24, 2026

## Problem and correction

The October 23 WDIO run used 10 exploration steps and produced seven mostly
tap/navigation cases. Typing was explicitly filtered from the model's controls,
the coverage controller rejected `type`, and generation discarded redacted input
and all later replay setup. Login/sign-up switching therefore dominated the run.

The new controller supports stable editable-field identities, named synthetic
inputs, clear/replace and keyboard dismissal, replayable typed setup, meaningful
submission assertions, and feature tracking. An app-specific WDIO v2.2.0 profile
adds independently specified behavior contracts, with source kind `app_profile`.
These are distinct from model-selected observation-derived regressions.

Twenty profile scenarios cover Forms echo/Unicode/clear/replace/persistence;
dropdown selection; switch on/off; valid login and sign-up; invalid/empty email;
password length 7/8; confirmation mismatch; cancellation/dismissal; carousel,
vertical scrolling, and nine-piece drag/drop. Unfinished workflows are reported,
not counted as complete cases. Failed final assertions remain available for replay.

The profile has 102 planned actions including relaunches. A 40-step budget normally
completes the first nine scenarios and starts the next. Use 120 with `--profile-only`
to attempt the complete known profile, with recovery allowance and zero model
requests. This does not establish whole-app coverage. Real applications require
test accounts and appropriate expected outcomes; this demo only shows success
alerts and has no authenticated dashboard.

## Verification and original evidence

- `python -m unittest discover -s mobile/tests -p 'test*.py'`: 64 tests passed,
  including fixture privacy, typed setup retention, complete/partial scenarios,
  exact value checks, duplicate native aliases, keyboard handling, and provenance.
- End-to-end discovery/replay: `logs/vision/20261024_070210_606857Z/` used 40 steps,
  generated nine complete functional cases, and originally replayed 8/9 as passing.
  The failed dropdown assertion was a harness ambiguity between a native wrapper
  and its child, despite the expected value being present. The current profile
  targets the editable child explicitly; subsequent dropdown replay passed.
- `logs/benchmarks/wdio_functional_20261024_073646Z/report.json`: dropdown,
  password 7/8, mismatch, and navigation persistence passed. Scrolling and puzzle
  settling exposed additional harness issues and were corrected/retested below.
- `logs/benchmarks/wdio_functional_20261024_074559Z/report.json`: the full nine-piece
  puzzle passed with its explicit `Congratulations` assertion. Slow first native
  snapshots now get one confirmation observation instead of immediate false
  instability. UiAutomator command timeouts are bounded.
- `logs/benchmarks/wdio_functional_20261024_074856Z/report.json`: vertical scrolling
  passed after steering gestures outside the horizontal carousel's interception
  area, checking the actual hidden `You found me!!!` text.
- `logs/benchmarks/wdio_functional_20261024_075112Z/report.json`: all five remaining
  checks passed: empty login, switch round-trip, clearing input, replacing input,
  and dismissing the login success alert.
- `logs/benchmarks/wdio_functional_20261024_075614Z/report.json`: valid login
  passed again on the corrected Appium setup, superseding the older timeout.

All twenty current profile definitions have passing live evidence across these
batches and the earlier discovery/replay. The local
`logs/benchmarks/wdio_functional_validation_index_20261024.json` index compares
each stored setup, steps, cleanup, and oracle to the current definition before
selecting its latest result. This is an evidence index, not a claim that one
20-case execution passed. Historical failed/debug reports remain unchanged.

The carousel assertion checks that the expected title occupies enough of the
viewport; merely finding a clipped adjacent card's text does not pass. Generic
observed expectations are still labeled as observed, not independent requirements.

Live validation used screenshots + YOLO and `VISION_OCR_MODE=fallback`, with native
accessibility for available labels. Normal commands retain full OCR. Initial
full-perception checks also exercised typed Forms input before the longer run.
Validation commands omitted `--comparison`; no verification run was uploaded to
Supabase. Earlier interrupted/debug attempts remain local and are not replacements
for the original evidence. The full-contract benchmark helper is explicitly labeled
`explicit_profile_validation`, not an AI-generation benchmark.

## Running it

From `mobile/`, with Appium and the emulator available:

```powershell
python vision/explore_vision.py --max-steps 40 --app-package com.wdiodemoapp --app-activity .MainActivity --execute-generated --app wdio-demo --comparison wdio-functional-01
python vision/explore_vision.py --max-steps 120 --profile-only --app-package com.wdiodemoapp --app-activity .MainActivity --execute-generated --app wdio-demo --comparison wdio-functional-full-01
```

The first command uses the normal budgeted hybrid workflow; the second attempts
the full known profile. Upload still depends on the mobile database environment.
Policy, scenario summary, coverage, and model-call count are retained inside the
existing `run_details` JSON without a schema change. The configured model name is
not evidence that any request was made; inspect `llm_calls`.

`--behavior-profile off` selects free exploration with controlled input instead.
User-authored requirements can use private `MOBILE_TEST_*` environment references
for real test accounts. Never substitute synthetic credentials and claim a real
authenticated destination was verified.
