# Capstone Project — AI-Assisted Test Case Generation for Mobile and Web UI/UX Applications

Team 101, PES University.

| Folder | Architecture |
|---|---|
| `web/`    | Architecture A — DOM + Memory Log (selector-based, text LLM) |
| `vision/` | Architecture B — Vision (screenshot → ScreenParser YOLO + OCR → visual DOM → coordinate-based tests) |
| `mobile/` | Mobile exploration (Appium) |

Each architecture is independent; see the README inside each folder.

## Unified Web Demo

Run both web architectures against the SAME URL in parallel under one shared run ID:

```bash
node runBoth.js
# Enter website URL:
# > https://demoqa.com
```

- One URL, one run ID (`run_YYYYMMDD_HHMMSS`).
- Architecture A and Architecture B start simultaneously and stay technically
  independent (separate pipelines, separate outputs).
- Results are separated into one run folder:

```
runs/<run_id>/
├── run_manifest.json   statuses, timings, artifact lists
├── dom/                Architecture A: memory_log.json, screenshots/, ...
└── vision/             Architecture B: screenshots/evidence, visual DOMs,
                        generated test cases, execution results
```

If one architecture fails, the other still runs to completion and the failure is
recorded in the manifest (`overall_status`: SUCCESS / PARTIAL_FAILURE / FAILED).
