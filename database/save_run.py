"""Shared Python uploader. Standard library only; Python 3.10+."""
import hashlib
import json
import math
import os
from datetime import datetime
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from urllib.parse import urlparse
from uuid import uuid4

LOCAL = Path(__file__).parent / 'local'
ALIASES = {'expected': 'passed', 'unexpected': 'failed', 'timedOut': 'timed_out'}
STATUSES = {'passed', 'failed', 'skipped', 'timed_out', 'flaky'}

class SupabaseHTTPError(RuntimeError):
    """HTTP diagnostics without credentials, headers, payloads or failing row data."""
    pass


def validate(run):
    run = dict(run)
    run.pop('owner', None)
    for key in ('run_id', 'app_id', 'comparison_id', 'created_at'):
        if not isinstance(run.get(key), str) or not run[key].strip():
            raise ValueError(f'Missing {key}')
    datetime.fromisoformat(run['created_at'].replace('Z', '+00:00'))
    details = run.get('run_details')
    if details is not None and not isinstance(details, dict):
        raise ValueError('run_details must be an object or null')
    details = dict(details or {})
    llm = details.get('llm')
    if llm is not None and not isinstance(llm, dict):
        raise ValueError('run_details.llm must be an object or null')
    llm = dict(llm or {})
    # Migrate locally queued flat metadata to the existing shared JSON contract.
    for old, target in (('exploration_stop_reason', 'stop_reason'), ('exploration_complete', 'exploration_complete')):
        if old in run:
            value = run.pop(old)
            if value is not None:
                if details.get(target) is not None and details[target] != value:
                    raise ValueError('Conflicting exploration metadata')
                details[target] = value
    if 'model' in run:
        value = run.pop('model')
        if value is not None:
            if llm.get('model') is not None and llm['model'] != value:
                raise ValueError('Conflicting model metadata')
            llm['model'] = value
    for key, value in (('model', llm.get('model')), ('stop_reason', details.get('stop_reason'))):
        if value is not None and (not isinstance(value, str) or not value.strip()):
            raise ValueError(f'{key} must be a nonempty string or null')
    if details.get('exploration_complete') is not None and not isinstance(details['exploration_complete'], bool):
        raise ValueError('exploration_complete must be boolean or null')
    if llm:
        details['llm'] = llm
    run['run_details'] = details

    if run.get('platform') not in ('web', 'mobile') or run.get('architecture') not in ('A', 'B'):
        raise ValueError('Invalid platform/architecture')
    if run.get('execution_state') not in ('completed', 'incomplete'):
        raise ValueError('Invalid execution_state')
    for key in ('memory_log', 'test_cases', 'execution_results'):
        if not isinstance(run.get(key), list):
            raise ValueError(f'{key} must be an array')
    ids = [t.get('id') for t in run['test_cases']]
    if any(not isinstance(i, str) or not i for i in ids) or len(set(ids)) != len(ids):
        raise ValueError('Test cases require unique string IDs')
    results, seen = [], set()
    for r in run['execution_results']:
        status = ALIASES.get(r['status'], r['status'])
        duration = float(r.get('duration_ms', r.get('durationMs', 0)))
        if r.get('id') not in ids or r['id'] in seen or status not in STATUSES or not math.isfinite(duration) or duration < 0:
            raise ValueError('Invalid result ID/status/duration')
        seen.add(r['id'])
        results.append(dict(id=r['id'], status=status, duration_ms=duration,
                            error=r.get('error'), original_status=r.get('original_status', r['status']),
                            attachments=r.get('attachments', [])))
    if run['execution_state'] == 'completed' and (not ids or len(results) != len(ids)):
        raise ValueError('Completed runs must have a result for every case')
    run['execution_results'] = results
    return run

def request(method, query, payload=None, env=None):
    env = os.environ if env is None else env
    url = env.get('SUPABASE_URL', '').rstrip('/')
    key = env.get('SUPABASE_SERVICE_ROLE_KEY')
    if urlparse(url).scheme != 'https' or not key:
        raise ValueError('Missing HTTPS Supabase URL/server key')
    req = Request(url + '/rest/v1/' + query, method=method,
                  data=None if payload is None else json.dumps(payload, allow_nan=False).encode(),
                  headers={'apikey': key, 'Authorization': 'Bearer ' + key,
                           'Content-Type': 'application/json',
                           'Prefer': 'resolution=merge-duplicates,return=minimal'})
    try:
        with urlopen(req, timeout=15) as response:
            data = response.read()
            return json.loads(data) if data else None
    except HTTPError as error:
        try:
            diagnostic = json.loads(error.read().decode('utf-8'))
            code = str(diagnostic.get('code', 'unknown'))[:80]
        except (ValueError, UnicodeError, AttributeError):
            code = 'unknown'
        # Report only status/code, not server details that may include a row's data.
        raise SupabaseHTTPError(f'Supabase HTTP {error.code} ({code}); check credentials/schema') from None


def upload_run(run, env=None):
    request('POST', 'runs?on_conflict=run_id', validate(run), env)

def save_run_to_db(run, directory=LOCAL, env=None):
    run = validate(run)
    env = os.environ if env is None else env
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    file = directory / (hashlib.sha256(run['run_id'].encode()).hexdigest() + '.json')
    record = {'run': run, 'pending': True}
    def write():
        temp = file.with_suffix('.' + str(uuid4()) + '.tmp')
        temp.write_text(json.dumps(record, allow_nan=False), encoding='utf-8')
        os.replace(temp, file)
    write()
    if env.get('DB_UPLOAD_ENABLED') != 'true':
        return {'file': str(file), 'uploaded': False, 'reason': 'Upload disabled'}
    try:
        upload_run(run, env)
        record['pending'] = False
        write()
        return {'file': str(file), 'uploaded': True}
    except Exception as error:
        return {'file': str(file), 'uploaded': False, 'reason': str(error) if isinstance(error, SupabaseHTTPError) else type(error).__name__}
