"""Retry saved runs or export shared/local data into a standalone SQLite snapshot."""
import argparse
import json
import os
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from save_run import LOCAL, request, upload_run, validate, SupabaseHTTPError

def load_env(file):
    for line in Path(file).read_text(encoding='utf-8-sig').splitlines():
        if line.strip() and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            os.environ.setdefault(key.strip(), value.strip().strip('\"\''))

def snapshot(runs, output):
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    # Refuse overwrite; preserve the last known-good snapshot.
    if output.exists():
        raise ValueError('Snapshot already exists; choose a new output filename')
    runs = [validate(r) for r in runs]
    columns = ['run_id','platform','architecture','app_id','comparison_id','created_at','execution_state','run_details','memory_log','test_cases','execution_results']
    with closing(sqlite3.connect(output)) as db, db:
        db.execute('CREATE TABLE runs (' + ','.join(c + ' TEXT' + (' PRIMARY KEY' if c == 'run_id' else '') for c in columns) + ')')
        for run in runs:
            db.execute('INSERT INTO runs VALUES (' + ','.join('?' for _ in columns) + ')',
                       [json.dumps(run.get(c)) if isinstance(run.get(c), (list, dict)) else run.get(c) for c in columns])
        counts = ','.join("(select count(*) from json_each(r.execution_results) e where json_extract(e.value,'$.status')='" + status + "') as " + status for status in ('passed','failed','timed_out','skipped','flaky'))
        db.execute("CREATE VIEW run_summary AS SELECT run_id,platform,architecture,app_id,comparison_id,created_at,execution_state,json_extract(run_details,'$.stop_reason') as exploration_stop_reason,json_extract(run_details,'$.exploration_complete') as exploration_complete,json_extract(run_details,'$.llm.model') as model,json_array_length(test_cases) as generated,(select count(*) from json_each(r.execution_results) e where json_extract(e.value,'$.status') <> 'skipped') as executed," + counts + ' FROM runs r')
        for platform in ('web', 'mobile'):
            for arch in ('A', 'B'):
                db.execute(f"CREATE VIEW {platform}_{arch.lower()}_runs AS SELECT * FROM run_summary WHERE platform='{platform}' AND architecture='{arch}'")
        db.execute('CREATE TABLE snapshot_metadata (exported_at TEXT, run_count INTEGER)')
        db.execute('INSERT INTO snapshot_metadata VALUES (?,?)', (datetime.now(timezone.utc).isoformat(), len(runs)))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['retry', 'export'])
    parser.add_argument('--env', help='Path to pipeline .env (simple KEY=value format)')
    parser.add_argument('--directory', default=str(LOCAL))
    parser.add_argument('--local', action='store_true', help='Export local bundles instead of downloading all shared runs')
    parser.add_argument('--output', default=str(Path(__file__).parent / 'backups' / ('snapshot-' + datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S') + '.db')))
    args = parser.parse_args()
    if args.env:
        load_env(args.env)
    files = sorted(Path(args.directory).glob('*.json'))
    if args.command == 'retry':
        failures = 0
        for file in files:
            record = json.loads(file.read_text())
            if not record['pending']:
                continue
            try:
                upload_run(record['run'])
                record['pending'] = False
                temp = file.with_suffix('.tmp')
                temp.write_text(json.dumps(record), encoding='utf-8')
                os.replace(temp, file)
                print('Uploaded', record['run']['run_id'])
            except Exception as error:
                failures += 1
                print('Pending', record['run']['run_id'], str(error) if isinstance(error, SupabaseHTTPError) else type(error).__name__)
        raise SystemExit(1 if failures else 0)
    if args.local:
        runs = [json.loads(f.read_text())['run'] for f in files]
    else:
        runs, offset = [], 0
        while True:
            page = request('GET', f'runs?select=*&order=run_id&limit=100&offset={offset}')
            if not page:
                break
            runs.extend(page)
            offset += len(page)
    snapshot(runs, args.output)
    print(f'Exported {len(runs)} runs to {args.output}')

if __name__ == '__main__':
    main()
