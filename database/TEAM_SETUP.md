# Team setup: save your pipeline results in our shared database

Our Supabase database is already created. Do not create another project or run setup.sql.
No owner name/ID is needed. Screenshots are not uploaded by these helpers.

## 1. Get the code

Pull the latest repository. Keep the database folder beside your pipeline folder:

```text
Capstone-Project/
  database/
  web/             Nidhi's pipeline
  your-folder/     your pipeline; its name can be anything
```

## 2. Add private settings

Create .env inside your own folder. Ask Nidhi privately for the URL and server key.
Keep your existing LLM settings and add:

```dotenv
SUPABASE_URL=the_shared_project_url
SUPABASE_SERVICE_ROLE_KEY=the_shared_server_key
DB_UPLOAD_ENABLED=true
```

Do not commit .env or send screenshots containing the key. Do not put this key in a
webpage. It is for trusted local pipeline scripts only.

## 3. Check your three output files

You need memory log JSON, test cases JSON and execution results JSON. These files
may have any names; pass their actual paths in the upload command.
Memory log and test cases must each be JSON arrays. Cases need unique string IDs.
Each result must refer to a case ID, using this format:

```json
[
  {"id":"TC001","status":"passed","duration_ms":1250,"error":null},
  {"id":"TC002","status":"failed","duration_ms":2400,"error":"Button not found"}
]
```

Allowed statuses: passed, failed, skipped, timed_out, flaky.
Playwright expected/unexpected/timedOut and durationMs also work.
The results file can be an array or a summary object with a results array.
Other result formats need a small conversion in your pipeline first.
Completed runs need one result for every generated case. If execution stopped early,
use --state incomplete. Tests failing does not mean the run itself is incomplete.

## 4. Choose identifiers

| Pipeline | platform | architecture |
| --- | --- | --- |
| Web structure | web | A |
| Web vision | web | B |
| Mobile structure | mobile | A |
| Mobile vision | mobile | B |

- app: website/app name, for example demoqa.
- comparison: agreed experiment label, for example demoqa-01. Matching A/B runs use the SAME app and comparison.
- run-id: unique label for YOUR run, for example demoqa-web-b-01. A/B must have DIFFERENT run IDs.

Retrying the same run uses the same run ID and replaces the existing row. A new
experiment uses a new run ID. Include platform and architecture in your ID to avoid
accidentally replacing somebody else's row.

## 5. Upload a completed run

Run the command from the repository root after your normal test executor finishes.
Replace your-folder and filenames with your real paths. Quote paths containing spaces.

Python example for Web B (Python 3.10+, no new packages needed):

```powershell
python database/upload.py --env your-folder/.env --platform web --architecture B --app demoqa --comparison demoqa-01 --run-id demoqa-web-b-01 --memory your-folder/logs/memory_log.json --cases your-folder/logs/test_cases.json --results your-folder/logs/results.json
```

Node example for Web B (Node 18+, no new packages needed):

```powershell
node database/upload.js --env your-folder/.env --platform web --architecture B --app demoqa --comparison demoqa-01 --run-id demoqa-web-b-01 --memory your-folder/logs/memory_log.json --cases your-folder/logs/test_cases.json --results your-folder/logs/results.json
```

For Mobile A or B, change --platform to mobile, choose architecture A or B, and
use your Android app name and agreed comparison label. Choose either uploader based
on the language installed on your laptop; both use the same database and format.

Expect Uploaded successfully. If it says Saved locally, the files are safe in
database/local. Fix your connection/settings, then retry:

```powershell
python database/manage.py retry --env your-folder/.env
```

Retry needs Python and uploads all pending bundles on this laptop. You can also
rerun the original upload command with the same run ID and unchanged output files.

## 6. Make it automatic

First verify one upload manually. Then call save_run_to_db (Python) or saveRunToDb
(Node) at the end of your executor. See README.md for code examples. Generate and
retain the run ID when your experiment starts. Load your own .env before calling.
The command above also works as a final step in your existing workflow script.

Nidhi's Web A already saves and uploads automatically through npm run test:generated.
The other executors are on teammates' laptops and still need that final connection.

## 7. Confirm the upload

Ask Nidhi to check runs for your run ID and run_summary for pass/fail counts. Compare
the counts against your local output. Upload only one representative run first.

## Message to share

We have one shared Supabase database ready. Pull the latest code and read
database/TEAM_SETUP.md. Add the private database settings to your folder's .env.
After your tests finish, use the Python or Node upload command in the guide with
your three JSON files. Match app/comparison IDs with the other architecture, but
use your own unique run ID. No owner ID is needed. Verify one upload before doing
all websites/apps. I will share the credentials privately.
