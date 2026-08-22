# Capstone Project — FINAL Combined Context (Vision Architecture B focus)

This document is the authoritative handoff for the combined Capstone repository
("AI-Assisted Test Case Generation for Mobile and Web UI/UX Applications", team 101,
PES University). Updated 2026-08-22 after final integration, validation, and release
branch creation. All metrics are measured from actual pipeline runs and saved result files.

---

## 1. REPOSITORY / GIT STATE (FINAL)

- **Active working repository:** `C:\Users\sandeep\pes\vs code\Capstone-Project`
- **Remote:** `https://github.com/Neonishh/Capstone-Project.git`
- **FINAL INTEGRATED BRANCH:** `capstone-final-integrated`
- **Final integrated commit:** `a317bfe0be0b405b419bed653e8d112b9afe3218`
  (`feat: integrate web vision architecture` — merge of Vision work into team main)
- Remote branch exists and is synchronized with local (verified via ls-remote).
- **Pull Request #5:** `capstone-final-integrated` → `main`, title
  "feat: integrate Vision Architecture with Web and Mobile". Open, mergeable, NOT merged.
- **origin/main was NOT modified** by the integration work; it remains at
  `5ddae6404624d508df04fd7040467e01c556399a`.
- `vision-architecture-final` branch was deleted (local + remote) after verifying via
  `git merge-base --is-ancestor` that all of its content is contained in the final branch.
- Remaining remote branches: `main`, `mobile-exploration`, `web-branch`,
  `feature/web-exploration-arch-a`, `integration/web-vision-mobile`,
  `arch-b-vision` (old obsolete prototype, left untouched deliberately),
  `capstone-final-integrated`.

### IMPORTANT: local vs remote main distinction

The LOCAL `main` ref in this clone has diverged from origin/main (it holds old unpushed
Vision commits, ahead 4 / behind 4). This is a pre-existing local-only artifact and is NOT
the team state. The team's true main is `origin/main` @ `5ddae64`. Do not push local main;
reset it to origin/main only if explicitly requested.

### IMPORTANT: correct branch for current work

- `vision-architecture-final` was the standalone completed Vision branch — now DELETED.
- `capstone-final-integrated` is the FINAL COMBINED branch (team main + Vision + Mobile).
- All current combined work belongs on `capstone-final-integrated`.
- Do not confuse this clone with the older local copy:
  `C:\Users\sandeep\CAPSTONE\Capstone-Project` → actually
  `C:\Users\sandeep\pes\CAPSTONE\Capstone-Project`. NEVER use it.

---

## 2. FINAL PROJECT STRUCTURE

```
capstone-final-integrated /
├── web/       = Architecture A (DOM + memory log, selector-based)
├── vision/    = Architecture B / Web Vision (screenshot + ScreenParser YOLO + OCR)
├── mobile/    = Mobile architecture (Appium-based exploration, offline dry-run framework)
├── database/  = database components (capstone.db)
├── docs/      = documentation / dashboard (Phase-1 reports, PPTs)
└── VISION_CONTEXT.md  ← this file
```

All three architectures coexist independently. No cross-wiring.

---

## 3. VISION ARCHITECTURE B — FINAL IMPLEMENTATION

### Pipeline (actual, verified)

```
Website URL
  → browser screenshot        (vision/services/browser-service/browser.js :5004)
  → ScreenParser YOLO11-L     (vision/services/yolo-service/detect.py :5001)
  → OCR / Tesseract           (vision/services/ocr-service/ocr.py :5002)
  → YOLO+OCR merge            (vision/services/merge-service/merge.js :5003)
  → Visual DOM JSON           (saved to vision/storage/outputs/)
  → LLM                       (vision/src/llm.js → Groq openai/gpt-oss-120b)
  → JSON coordinate test cases (vision/src/testGenerator.js, prompt from visualDom.js)
  → permanent Playwright executor (vision/src/executeTests.js)
  → execution results JSON    (vision/storage/outputs/execution_results*.json)
```

One-shot runner: `node runVision.js <url>` (spawns all services, generates tests,
kills the full Windows process tree on shutdown).

Executor:
```
node src/executeTests.js <test_cases.json> <base_url> [output_path]
```

### Components & configuration
- **Detector:** docling-project/ScreenParser (YOLO11-L, 55 UI classes).
  Local weights `screenparser_best.pt` (~146 MB, GITIGNORED — re-download from
  Hugging Face on fresh clones). Config: `YOLO_CONF=0.15`, `YOLO_IMGSZ=640`.
- **OCR:** Tesseract (`TESSERACT_CMD`, default Windows path), `OCR_MIN_CONF=40`,
  Otsu threshold + psm 11.
- **Merge:** centre-in-box OR IoU>0.1 word matching; per-element yolo/ocr/combined
  confidence; row-sorted text.
- **LLM:** Groq `openai/gpt-oss-120b`; evidence-based prompt in `visualDom.js`
  separates observable facts ("evidence") from hypotheses ("inferred_behavior") and
  runtime-verifiable outcomes; explicit rule: never infer a navigation target not
  present in evidence. Generation budget max(GROQ_MAX_TOKENS, 4500) with one retry
  on parse failure.
- **Test schema:** id, objective, evidence[], inferred_behavior, steps[]
  ({action: click|fill|navigate|scroll, x, y, value}), expected_result,
  expect_navigation, expected_text. Backward compatible with older files.
- **Executor:** one browser/context, fresh page per test, honors `expect_navigation`
  (falls back to URL-text heuristic for legacy files), guaranteed cleanup
  (try/finally + SIGINT handler), single test failure never aborts the suite.
- **Process cleanup:** runVision.js kills process trees via `taskkill /T /F` on
  Windows (fixes port leakage on 5000–5004).
- **Env:** see `vision/.env.example`; secrets live only in untracked `vision/.env`.

### Closed-loop execution & evidence (FINAL)

Execution is no longer open-loop. For every executed action:
```
current-state screenshot → YOLO+OCR → visual DOM
  → target RE-RESOLVED on the CURRENT state (type + OCR text match;
    one controlled proximity fallback; never stale coordinates)
  → Playwright action at the resolved centre
  → post-action screenshot      storage/screenshots/<run_id>/state_NNN_after_<action>.png
  → YOLO+OCR+merge RE-DETECTION of that screenshot via gateway /vision/process
  → new visual state recorded   {state_id, screenshot, url, elements, ocr_words,
                                 elements_delta, merged evidence image}
  → semantic verification signal collected
  → assertion → PASS/FAIL with named verification method + strength
```

Service lifecycle: the executor AUTO-STARTS all Vision services (including
gateway) via `src/serviceManager.js` when none are running — no dependency on a
previous `runVision.js` process. Only services it spawned are shut down
(Windows-safe process-tree kill); pre-existing processes are left untouched.
No orphaned processes or listeners remain after a run.

Per-step target resolution: generated steps carry `target {type, text}` hints;
the executor re-finds the element in the freshly detected state and uses ITS
centre coordinates. If the target cannot be found, the step FAILS with
`unresolved_target` — stale coordinates are never clicked. Steps record
`resolved_element`, `resolution_via`, `re_detected`,
`stale_coordinates_prevented`, `state_id_before`; tests record
`stale_coordinates_prevented` / `unresolved_targets` totals.

Verification methods (strongest-first), recorded per test with a
`verification` field plus `verification_strength` (strong / moderate / weak / none):
`input_value` (field provably holds typed value) · `checked_state` (radio/checkbox
toggled — labels resolved to their controls via HTMLLabelElement.control) ·
`scroll_position` · `visual_state_change` · `url_change` · `body_text_fallback`
(weak; always flagged as a warning). A strong semantic expectation that finds no
observable signal is FAILED — body-text evidence can never silently satisfy it.

Confidence policy for candidate elements: HIGH ≥0.6 normal; MEDIUM 0.3–0.6 allowed
with conservative expectations only; LOW <0.3 or no OCR text excluded.

Evidence artifacts per run (`vision/storage/screenshots/<run_id>/`, gitignored):
initial/YOLO/OCR/merged annotated images for the captured state, per-action
post-action screenshots AND merged evidence for every re-detected state, and
failure screenshots. All JSON outputs reference exact relative paths; previous
runs are never overwritten. Annotated images are rendered from existing detection
data by the YOLO service (`/render_boxes`) — no extra detector.

**Closed-loop validated runs (2026-08-22):**
- Forms: 6/6 multi-step tests PASS, 12 states re-detected, 13 merged evidence
  images, 2 stale-coordinate corrections, verification: input_value ×1,
  checked_state ×2, scroll_position ×2, fallback ×1 (flagged).
- Homepage cross-page workflow replay: 8 states re-detected across 7 URLs;
  every step resolved from its fresh state (`elem-3 "Elements"` → /elements,
  `elem-15 "Check Box"` → /checkbox, … `elem-22 "Links"` → /links);
  final fill verified strong (input_value). PASS.

Multi-step workflows: the generator now produces 2–6-step sequences
(fill→fill→submit, choice workflows, navigation, scroll) instead of single clicks;
4–6 tests per page.

### Autonomous multi-page exploration mode (FINAL)

`node runVision.js --explore <url>` (normal one-shot mode unchanged).

Closed exploration loop, fully Vision-driven (screenshot/YOLO/OCR only):
```
capture -> YOLO+OCR+merge -> candidate table from CURRENT state only
-> LLM picks ONE action (element id only; coordinates are bound to the table,
   the LLM can never supply stale/invented coordinates)
-> Playwright executes -> post-action screenshot -> re-detect
-> state fingerprint (URL + normalized-text hash + element-signature hash)
-> repeated? mark tried + browser goBack : adopt new state
-> repeat until termination criteria
-> discovered workflows converted to replayable test cases (no invented steps)
```

- Limits (env-overridable): `EXPLORE_MAX_STEPS=25`, `EXPLORE_MAX_STATES=12`,
  `EXPLORE_MAX_DEPTH=8`, `EXPLORE_MAX_ACTIONS_PER_STATE=4`.
- Anti-loop protections: fingerprint dedup, per-state action caps, per-(type,text)
  failure blacklist (a click producing no page change or a non-http destination
  scores 2 = immediate blacklist; other failures score 1), anti-laziness reprompt
  refusing `done` while untried candidates remain, transient-LLM-error retry.
- Non-http destinations (about:blank/ad redirects) are rejected automatically.
- Outputs per run: `storage/outputs/<run_id>_exploration_history.json`,
  `<run_id>_exploration_result.json`, `test_cases_<run_id>_exploration.json`
  (executor-compatible), plus per-state screenshots/merged evidence.

**Validated results (DemoQA, 2026-08-22):**
- Homepage: **9 states / 8 unique URLs** (/, /elements, /checkbox, /webtables,
  /upload-download, /buttons, /text-box, /links), 8 actions (7 clicks + 1 fill),
  termination `max_depth_reached`; discovered 8-step cross-page workflow replayed
  by the permanent executor: **PASS (input_value verification)**.
- Forms: 7 states, 6 successful form fills, repeated/dead-end handling exercised,
  termination `max_actions_per_state_reached`; discovered fill-workflow replay: **PASS**.
- Evidence: 22 + 23 artifacts in respective run folders.

Exploration limitations (documented, not hidden): ScreenParser banner/footer
pseudo-links waste attempts (mitigated by the failure blacklist, not eliminated);
rotating ad creatives change text/position between captures; fingerprinting treats
every visible text change as a new state (fill-heavy pages generate many states);
replay assumes pages render as during exploration; file choosers/iframes/native
dialogs unsupported.

### Key files
`runVision.js`, `src/llm.js`, `src/visualDom.js`, `src/testGenerator.js`,
`src/executeTests.js`, `gateway/app.js`, `services/*/{browser.js, detect.py, ocr.py, merge.js}`.

---

## 4. VISION VALIDATION RESULTS

### Final closed-loop validation (2026-08-22, integrated branch)

| Page | Elements | Tests | Exec | Pass | Fail | Multi-step | Fills | Scrolls | States re-detected | Verification methods used |
|---|---|---|---|---|---|---|---|---|---|---|
| Forms | 57 | 5 | 5 | 4 | 1 | 4/5 | 6 | 1 | 15 | input_value×2, checked_state×1, scroll_position×1, url_change×1, fallback×1 |
| Elements | 29 | 5 | 5 | 4 | 1 | 5/5 | 1 | 3 | 10 | url_change×1, scroll_position×2, fallback×2 |
| Widgets | 21 | 5 | 5 | 4 | 1 | 5/5 | 0 | 4 | 10 | url_change×2, scroll_position×2, fallback×1 |

- All screenshot references verified on disk: 88 JSON references, 0 missing.
- Failure causes (exact, one per run):
  - Forms TC04 — footer "RESERVED." pseudo-link asserted navigation (ScreenParser
    misclassification, conf ~0.33).
  - Elements TC01 — same category; low-confidence link expected URL change.
  - Widgets TC02 — "practice." ad-banner fragment detected as Link at conf 0.6
    (HIGH tier, so legitimately treated as navigational; actually a banner).
- Radio-coordinate investigation: clicks land correctly; the earlier missing
  `checked_state` signal was caused by probes hitting the wrapping `<label>`;
  fixed generally by resolving labels to their controls (`HTMLLabelElement.control`).

### Earlier single-shot validation (superseded by the closed-loop runs above)
| Page | Gen | Exec | Pass | Fail | Rate |
|---|---|---|---|---|---|
| Homepage | 10 | 10 | 10 | 0 | 100% |
| Homepage (earlier) | 8–9 | 8–9 | 8–9 | 0–1 | up to 100% |
| Alerts/Frames/Windows (single-shot era) | 7 | 7 | 4 | 3 | 57.1% |
| Interactions (single-shot era) | 6 | 6 | 3 | 3 | 50.0% |

Observed overall range across all validation: ~50–100% per page depending on how
many ambiguous banner/footer pseudo-links ScreenParser produces for that layout.
Do NOT claim universal reliability; pass rate = execution+verification success,
NOT overall system accuracy (detector/OCR/action quality are reported separately).

---

### Unified A+B demo runner (FINAL)

`node runBoth.js [url]` (interactive URL prompt when no argument is given).

Starts Architecture A (`web/explore.js`) and Architecture B
(`vision/runVision.js` one-shot + `src/executeTests.js`) CONCURRENTLY against
the same URL under one shared run ID, with strictly separated output trees:

```
runs/<run_id>/
├── run_manifest.json   per-architecture status, timings, artifact lists
├── dom/                Architecture A artifacts (memory_log, screenshots, ...)
└── vision/             Architecture B artifacts (evidence, visual DOM,
                        test cases, execution results)
```

- Orchestrator only — neither architecture's internals were modified.
- B's executor is bound to the visual-DOM run created during the SAME unified
  run; stale test cases from previous runs can never be executed.
- One architecture failing never blocks the other; manifest records
  SUCCESS / PARTIAL_FAILURE / FAILED honestly.
- Ports 5000-5004 pre-checked/freed before B starts; process trees killed on
  exit; no orphaned processes.
- API keys: env `GROQ_API_KEY` only (or the existing untracked .env files);
  never printed, never hard-coded.
- Validated clean run `run_20260822_145821`: A success (memory log +
  screenshots; shallow 2-step log is A's known limitation), B success
  (5/5 tests generated from its own run and executed, 100% pass).
- Related fix: `web/src/llmClient.js` model is now configurable
  (`GROQ_MODEL_A`, fallback `GROQ_MODEL`, default `openai/gpt-oss-120b`) —
  Groq decommissioned the previously hard-coded `llama-3.3-70b-versatile`.

## 5. ARCHITECTURE A — FINAL STATUS (`web/`)


Verified on the integrated branch:
- Entry point: `web/explore.js <url>`; modules: `src/domExtractor.js`,
  `src/preprocess.js`, `src/llmClient.js`, `src/memoryLog.js`, `src/testGenerator.js`.
- DemoQA smoke run works (stub mode): starts, loads page, extracts 8 homepage
  elements, exits cleanly. All modules pass `node --check`.
- DOM extraction works (tag filtering, visibility checks, selector building).
- Known limitations:
  - `testGenerator.js` is not wired into `explore.js`'s entry point (manual invocation required)
  - visited-state/repetition handling is mostly prompt-based ("alreadyUsed" flags)
    plus step caps (MAX_STEPS_PER_FLOW=12); no hard programmatic state detection
  - no committed automated test framework for A
  - full autonomous real-LLM exploration still needs end-to-end validation
    (long-running; headless:false)

## 6. MOBILE — FINAL STATUS (`mobile/`)

- Present and intact in the integrated project (team's newer version incl.
  dry_run.py, fake_driver.py, .env.example, refactored src/).
- Offline validation PASSED on the integrated branch: all 9 Python files compile;
  `python mobile/dry_run.py` exits 0 with all scenarios passing (stub loop +
  memory-log, scripted-LLM JSON test generation 2 steps → 1 case, back-action
  sideways exploration 4/4 steps).
- Requires `pip install -r mobile/requirements.txt` (incl. Appium-Python-Client)
  and `PYTHONIOENCODING=utf-8` on Windows consoles. No physical device needed for
  the offline framework.

## 7. INTEGRATION VERIFICATION

- Vision + Web + Mobile coexist on `capstone-final-integrated` @ `a317bfe`.
- Tree comparison vs team main: ONLY `.gitignore` differs (intentional fix);
  `web/`, `mobile/`, `database/`, `docs/` byte-identical — nothing overwritten.
- Tree comparison vs vision-final: identical except stale COCO `yolov8n.pt`
  (6.5 MB) removed intentionally.
- `.gitignore` corruption (UTF-16 mojibake tail) fixed during integration; now covers
  node_modules, `vision/.env`, temp_screenshots, storage outputs, both .pt weights.
- No tracked secrets anywhere (grep-verified); only `.env.example` files tracked.
- Largest tracked file: `mobile/ApiDemos.apk` (4.8 MB, pre-existing team asset).
- No references to `arch-b-vision`, old paths, or deleted files remain in tracked code.
- No known integration conflicts remain.

## 8. GITHUB / PR STATE

- **PR #5**: title `feat: integrate Vision Architecture with Web and Mobile`
  - source: `capstone-final-integrated`  target: `main`
  - status: OPEN, MERGEABLE, NOT merged
  - head SHA: `a317bfe0be0b405b419bed653e8d112b9afe3218`

## 9. REMAINING WORK

COMPLETED (do not redo):
- Vision Architecture B implementation, executor, evidence-based prompting,
  reliability fixes, multi-page validation, integration into team structure,
  release branch, PR #5.

REMAINING (genuine):
- Team review and merge of PR #5 into main
- Further Architecture A completion (wire in test generator; stronger
  visited-state handling; full autonomous exploration validation)
- Final project-wide evaluation
- Architecture A vs B comparison metrics
- Broader reliability/coverage evaluation across more sites/pages
- Final report / slides / dashboard deliverables if required
- Any additional integration requested by the team

## 10. CONTINUATION INSTRUCTIONS FOR ANOTHER AI

1. Read THIS FILE first.
2. Work on branch `capstone-final-integrated` (or a new branch off it). Never modify
   `main` directly; never force-push.
3. Active repo: `C:\Users\sandeep\pes\vs code\Capstone-Project`. Never touch the
   older clone at `C:\Users\sandeep\pes\CAPSTONE\Capstone-Project`.
4. Do not recreate or replace the completed Vision architecture — it is done and
   validated. Modify `vision/` only for genuine compatibility needs.
5. Check PR #5 status before making any integration decisions (it may already be merged).
6. Remember: model weights and .env files are gitignored; re-provision them locally
   when setting up a fresh environment (ScreenParser from Hugging Face, keys in .env).
7. Kill stray processes on ports 5000–5004 before manual Vision service starts;
   `runVision.js` cleans up after itself automatically.
