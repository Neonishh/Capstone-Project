# Mobile database integration

Mobile A and B use the shared `database/` Supabase helper from main. No separate
database or additional Python dependency is required. Python 3.10+ is required.

Copy the entries from `database/.env.example` into `mobile/.env`, keeping your
existing Appium and LLM settings. Get the existing project's credentials privately
from your teammate; do not commit the service-role key. See
`../database/TEAM_SETUP.md` for team setup and `../database/README.md` for schema setup.

Start with `DB_UPLOAD_ENABLED=false`. Runs are saved in `database/local/` even when
uploading is disabled or the network fails. Set it to `true` to attempt Supabase
uploads. Screenshots remain local; only JSON datasets and results are saved.

Run these commands from the repository root:

```powershell
# Architecture A: explore first, then generate and execute tests
python mobile/explore_mobile.py
python mobile/run_pipeline.py --app android-settings --comparison settings-01

# Architecture B: explore, generate and execute in one invocation
python mobile/vision/explore_vision.py --execute-generated --app android-settings --comparison settings-01

# Or execute an existing B run; its memory log must be beside the cases
python mobile/vision/vision_test_executor.py mobile/logs/vision/<run>/vision_test_cases.json --app android-settings --comparison settings-01

# Retry pending uploads using the original saved run IDs
python database/manage.py retry --env mobile/.env

# Export locally saved runs for an offline demo
python database/manage.py export --local
```

Use the same app and comparison IDs for A/B runs of the same experiment. Each
execution invocation gets a fresh UUID. Retrying an upload through `manage.py`
retains its UUID. Replaying tests is a new execution, with a new UUID.

`--comparison` enables saving; without it, the existing pipeline behavior continues.
`--app` defaults to the Android package. A run is saved as incomplete before tests
start and finalized after execution. Completed means every case has an outcome,
including failures. Empty suites and interrupted execution stay incomplete.
B exploration without `--execute-generated` saves an incomplete run if
`--comparison` is supplied. A's `--skip-execution` only generates artifacts and
does not save a database run.

Statuses and durations are adapted from each mobile executor to the shared schema.
Original detailed execution reports remain in the mobile logs. Test this integration:

```powershell
python -m unittest discover -s mobile/tests -v
python -m unittest discover -s database -p test_storage.py -v
```

The shared files were copied from `origin/main` while staying on
`mobile-exploration`. No branches were merged. When main is merged later, these
files should match unless the team changes the shared database implementation.


See [shared run metadata](../database/RUN_METADATA.md) for model/stop-reason fields, legacy NULLs,
web/mobile completion semantics, and existing-project migration instructions.
