# Web C runner session report

Use actual evidence and `NOT_RECORDED` for unavailable values. Record synthetic or redacted inputs. Keep credentials out of reports and evidence summaries.

## 1. Assignment and identity

| Field | Actual value / source |
|---|---|
| Architecture | C - Microsoft Playwright Test Agents |
| Run ID / app ID / comparison ID | |
| Goal / source and version / allowed origin | |
| Agreed starting state and fixtures | |
| Requested and actual model/reasoning | |
| Start / finish / measured duration | |

## 2. Environment and custody

Record Playwright and browser versions, headless mode, viewport, locale, context and profile isolation, and effective retry and timeout settings. Distinguish configured values from observed ones.

## 3. Goal checklist

| Requirement ID | Expected check | Case ID | Final state | Evidence |
|---|---|---|---|---|

List each required check, including those blocked or unexecuted.

## 4. Generated cases and assertions

For each case, record its stable ID, objective, preconditions, setup, actions, expected result, actual observation, assertion verdict, reason, evidence reference and cleanup. Identify which native Playwright test or step executed it. Preserve the expected result chosen before execution.

## 5. Actual execution and failures

| Case / attempt | Action or assertion | Result | Failure or repair reason | Evidence file |
|---|---|---|---|---|

Preserve the first execution and any healer diff and rerun separately.

## 6. Case results

| Case | Expected | Observed | Status | Duration / source | Evidence | Limitation |
|---|---|---|---|---|---|---|

Distinguish product defects, weak assertions, tooling failures and missing evidence. A test containing multiple assertions is one native test.

## 7. Verification method

Record whether the official planner and generator produced the saved plan and tests, with tool or artifact references. Record any manual edits or direct Playwright fallback. Mark unverified provenance explicitly.

## 8. Counts and completeness

Record native generated, executed, passed, failed, timed out, skipped and flaky counts. List reviewed requirements separately. Record run state, stop reason, scope completion, and any gaps in matched A/B/C settings or fixtures.

## 9. Artifacts and export

Link the run folder, original plan and generated tests, first result JSON, logs, screenshots or traces, report and any healer outputs.

## 10. Supabase

Record local-only status or authorized upload target, payload and readback receipt.

## 11. Cleanup and handoff

Record the final page, cleanup performed, preserved state and any open blocker.

## 12. Missing fields

List unsupported or unmeasured fields with the reason and nearest evidence reference. Keep unrecorded times, tokens, costs and runtime model information unknown.
