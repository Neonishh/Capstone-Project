# Shared web/mobile run metadata

## Findings from the supplied October 23 CSVs

`web_a_runs_rows.csv` has 9 rows and `mobile_b_runs_rows.csv` has 4. These are
separate runs, so row counts need not match. Both exports have exactly the same
17 column names and order. The mobile export has blank CSV cells for `model`,
`exploration_stop_reason`, and `exploration_complete`; web rows populate them.
The mobile producer previously sent none of those fields. The local setup/export
code also predates the JSON metadata support already present in the live views.

Counts are internally consistent in these exports. For example, the mobile run
`078efa59-df51-485e-9225-c9e8ee4dfba5` has 11 generated/executed tests with 9 passed
and 2 failed. SQL NULL metadata is not a failed upload or zero test count.

## Contract for all four architectures

| Field | Meaning |
| --- | --- |
| `model` | Model configured when exploration happened; null when unrecorded |
| `exploration_stop_reason` | Why exploration ended, e.g. `step_budget`, `rate_limit`, `agent_done`, `loop_detected`, `error` |
| `exploration_complete` | Boolean when known; false for budget/error stops; true only for a recorded normal agent completion; null for unknown history |
| `execution_state` | `completed` when every generated case has an outcome and execution finished; otherwise `incomplete` |

Completing a step budget does not establish whole-app coverage. Even `agent_done`
is the explorer's reported outcome, not independently measured full coverage.
A run may have `exploration_complete=false` and `execution_state=completed` if a
partial exploration produced cases that all finished replaying. A completed run
can include failed assertions. Do not overwrite these fields to make dashboards
look consistent.

The supplied web rows mark some fully executed partial suites `incomplete`. The
current shared contract permits conservative incomplete runs, but web/mobile
consumers should compare `exploration_complete` and executed/generated counts
separately. Align the web producer's definition with its owner rather than
silently rewriting its rows. That producer revision is not present in this checkout.

`memory_log` and `test_cases` remain platform-specific JSON arrays: Playwright/web
and Appium/mobile have different target/step details. Shared result fields are
`id`, normalized `status`, `duration_ms`, `error`, `original_status`, and
`attachments`. Null `error` on a passing case is expected. Screenshot paths refer
to local evidence; uploading JSON does not upload screenshot binaries.

## Changes

- Both mobile explorers record `exploration_metadata.json`, including a hash of
  the memory log. Mobile uploads include the three common metadata fields.
- Standalone mobile replay reads that saved metadata; it never labels old tests
  with whichever model is in today's `.env`. A changed history with a stale
  metadata file is rejected. Missing legacy metadata stays unknown.
- The Python/Node validators normalize optional metadata into `run_details` JSON,
  including legacy queued flat fields. Python mobile result
  normalization preserves attachments. Offline SQLite exports retain metadata in
  the same summary-view position as Supabase.
- `setup.sql` includes the optional JSON metadata column for fresh projects. The existing
  project migration is `migrations/20261023_run_metadata.sql`; it changes columns
  and the five known summary views but does not update/delete run records.

## Existing live schema (verified October 23)

The live `public.runs` table stores metadata in **`run_details` JSONB**. Summary
view columns are derived fields, not physical columns to include in an upload:

- `exploration_stop_reason` reads `run_details.stop_reason`.
- `exploration_complete` reads `run_details.exploration_complete`.
- `model` reads `run_details.llm.model`.

The first attempted mobile metadata fix assumed physical table columns from CSV
view headers. Supabase rejected that payload with HTTP 400 / PGRST204, reporting
that `exploration_complete` was absent from the schema cache. The uploader now
uses the existing web-compatible JSON contract instead. Legacy pending bundles
with flat metadata are normalized on retry; existing nested web details are
preserved. No live schema migration is needed on the verified project.

For a fresh or older database missing `run_details`, use the corrected setup or
`migrations/20261023_run_metadata.sql`. These scripts add `run_details` and derive
the view fields from JSON. They do not add physical `model` or exploration columns.
No live schema change was performed during the upload fix.

After a fresh mobile exploration/replay, inspect:

```sql
select run_id, model, exploration_stop_reason, exploration_complete,
       execution_state, generated, executed, passed, failed
from public.mobile_b_runs
order by created_at desc;
```

For a budget-limited run, expect the recorded model, `step_budget`, and `false`.
Execution will say `completed` only if its nonempty suite finishes with all outcomes.
Legacy NULLs are deliberately not auto-backfilled: the old `run_config.json`
files examined in this session recorded `model: null`, so the original model
cannot be recovered reliably from those files. Retry uploads alone does not
reconstruct missing metadata. Record a new run or provide independently verified
historical provenance before a targeted correction.


Verified upload: run `2a793e66-e333-480e-a0dd-964f95966114` now appears in
`mobile_b_runs` with 7 generated/executed, 6 passed, 1 failed, model `gpt-4o-mini`,
stop reason `step_budget`, exploration complete false, execution state completed.
Its local pending flag was cleared after reading back the summary. Other pending
runs were not uploaded and no emulator/API exploration was rerun.
