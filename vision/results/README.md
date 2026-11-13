# Web benchmark result snapshots

| File | Source | Runs | Distinct app IDs |
| --- | --- | ---: | ---: |
| [web-b-runs.json](web-b-runs.json) | Supabase public.web_b_runs | 46 | 44 |
| [web-c-runs.json](web-c-runs.json) | Supabase public.web_c_runs | 20 | 20 |

Snapshot date: 2026-11-13. Each row includes the summary view fields, recorded case IDs,
and exported case outcomes with durations where measured. Case outcomes come from
the corresponding public.runs row. The export retains partial runs and failures.

Missing per-case outcomes can occur in incomplete runs. A null duration indicates
no duration was recorded. Compare scope and fixtures before treating two runs as
a matched pair. Some Web C rows count reviewed checks from a single native test.

The export contains no raw screenshots, page text, credentials, browser traces,
agent transcripts, or request payloads.
