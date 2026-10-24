# Shared Supabase database

Teammates joining the existing project: start with [TEAM_SETUP.md](TEAM_SETUP.md).
It includes runnable Python and Node commands for uploading existing output files.

All four pipeline folders use this folder. No pipeline needs its own hosted database.
The old empty capstone.db is preserved; it is not used by this integration.

## One-time project setup

1. Create a free Supabase project at https://supabase.com/dashboard.
2. Open SQL Editor, paste setup.sql, and run it once. It is safe to rerun for this initial schema.
3. Find the project URL and server-side service_role key in project settings/API keys.
4. Copy the entries in database/.env.example into each pipeline's .env. Do not overwrite existing LLM settings.
5. Choose app ID and comparison ID for the experiment. A and B for the same experiment use the same comparison ID but DIFFERENT run IDs.
6. Set DB_UPLOAD_ENABLED=true to upload. Keep it false for local-only testing.

The schema enables RLS and denies anon/authenticated access. Only trusted server-side
scripts use the service-role key. This key bypasses RLS and is a project-wide secret:
share it privately with trusted teammates, never put it in Git, a browser, or screenshots.
Separate user accounts/policies
can be added later if teammates need restricted permissions. A dashboard must read
through a backend; no browser key or public access is configured here.

## Nidhi / Web A

Node 18+ is required. No additional npm dependencies are needed.
After setting credentials in web/.env, run the normal workflow from web/:

```powershell
npm run explore -- https://demoqa.com --app demoqa --comparison demoqa-01
npm run test:generated
```

The runner captures the current input JSON, executes tests, normalizes results,
saves a bundle in database/local, and attempts upload if enabled. Test failures still
upload, but the runner keeps its nonzero exit code. A crash produces an incomplete run.
Exploration creates a UUID and saves app/comparison IDs in web/logs/run_metadata.json.
Execution automatically reads this file and keeps the same run ID for retries or
intentional replacement. Starting a new exploration creates a new ID. Input hashes
prevent accidentally uploading changed logs/cases under stale experiment metadata.
Missing or incomplete exploration metadata blocks execution with a clear error.
No owner field is required. Existing RUN_APP_ID/RUN_OWNER/RUN_COMPARISON_ID/RUN_ID
entries in .env are ignored and may be removed.

Use setup.sql for both fresh and existing Supabase projects. It preserves stored runs,
removes the unused owner column if present, and rebuilds the comparison views.
If your database is already working without an owner column, no action is needed.

## Other Node pipelines

Import saveRunToDb using the relative path from your folder:

```javascript
const { saveRunToDb } = require('../database/saveRun');
const { randomUUID } = require('node:crypto');
// Load your folder's .env using dotenv, as your existing pipeline already does.
const runId = process.env.RUN_ID || randomUUID(); // generate ONCE at run start
// After execution:
await saveRunToDb({
  run_id: runId, created_at: new Date().toISOString(),
  platform: 'web', architecture: 'B', app_id: 'demoqa',
  comparison_id: 'demoqa-experiment-01', execution_state: 'completed',
  memory_log: memoryLog, test_cases: testCases, execution_results: results
});
```

## Python pipelines (mobile A/B and vision)

Python 3.10+; helper uses only the standard library. Load the pipeline .env yourself
or use manage.load_env (simple KEY=value parser, no variable interpolation).

```python
import sys
from pathlib import Path
from datetime import datetime, timezone
from uuid import uuid4
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'database'))
from save_run import save_run_to_db
from manage import load_env
load_env(Path(__file__).parent / '.env')
run_id = str(uuid4())  # generate once at run start; retain for upload retries
# After your own executor finishes:
saved = save_run_to_db(dict(
    run_id=run_id, created_at=datetime.now(timezone.utc).isoformat(),
    platform='mobile', architecture='A', app_id='android-settings',
    comparison_id='settings-experiment-01', execution_state='completed',
    memory_log=memory_log, test_cases=test_cases, execution_results=results))
print(saved)
```

Adjust the import path for deeper folders. Switch platform/architecture as
appropriate. The mobile exploration file in this checkout has no execution stage;
connect the helper to your teammate's actual executor, not immediately after generation.

## Shared result contract

Cases need unique string IDs. Results must reference those IDs, with one result per
case. If running multiple browsers/repetitions, assign distinct case IDs or separate runs.

```json
[{"id":"TC001","status":"passed","duration_ms":1250,"error":null}]
```

Statuses: passed, failed, skipped, timed_out, flaky. Playwright expected/unexpected/
timedOut are normalized. Interrupted/crashed tests need an adapter: mark run incomplete
and map the interrupted case to failed with an explanatory error. Unknown statuses are
rejected. Completed means the executor finished and every case has an outcome, NOT that
every test passed. Empty or partially executed suites must be incomplete.

## Retry and offline export (run from repository root)

```powershell
python database/manage.py retry --env web/.env
python database/manage.py export --env web/.env
python database/manage.py export --local
```

Retry reads pending bundles from either language; it explicitly uploads even when
DB_UPLOAD_ENABLED=false. Failed retries keep pending data and return a nonzero exit code.
Export downloads ALL shared runs with pagination. Stop team uploads during export to
keep the dataset consistent across pages. --local exports only this laptop's bundles.
Use --directory to choose another bundle folder and --output to choose a snapshot path.
Snapshots contain runs, matching summary/architecture views, and export metadata.
Existing snapshots are never overwritten. Copy the snapshot and selected artifacts
to the demo laptop/USB. SQLite snapshots do not contain screenshots/videos/traces.

## Dashboard queries

Read run_summary for counts, filter by platform/app_id/comparison_id, then sort by
architecture and created_at. web_a_runs/web_b_runs/mobile_a_runs/mobile_b_runs are
filtered summary views; fetch runs by run_id only when opening full details.
Executed excludes skipped; timed-out and flaky outcomes have separate columns.
For pass rate, document your denominator (e.g. passed / executed; zero gives no rate).
Choose matching runs explicitly when a comparison contains repeated experiments.

## Verification and scope

No screenshots are uploaded and no dashboard is built in this change. Local bundles
and backups are gitignored. Each same-ID upload replaces all JSON datasets in one row.
Do not run two writers for the SAME run ID: the last successful upload wins.
Free projects can pause; check activity before a demo. The offline snapshot avoids
requiring live database access for showing collected results.

Official references:
- https://supabase.com/docs/guides/database/postgres/row-level-security
- https://supabase.com/docs/reference/javascript/upsert
- https://supabase.com/docs/guides/platform/billing-on-supabase


See [shared run metadata](RUN_METADATA.md) for model/stop-reason fields, legacy NULLs,
web/mobile completion semantics, and existing-project migration instructions.
