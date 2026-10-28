import json
import io
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from save_run import save_run_to_db, validate, request, SupabaseHTTPError
from manage import snapshot

RUN = dict(run_id='test-run', platform='mobile', architecture='B', app_id='settings',
           comparison_id='pair', created_at='2026-10-14T00:00:00Z',
           execution_state='completed', memory_log=[], test_cases=[{'id': 'TC001'}],
           execution_results=[{'id': 'TC001', 'status': 'unexpected', 'durationMs': 4}])

class StorageTests(unittest.TestCase):
    def test_pending_and_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch('save_run.upload_run', side_effect=OSError('offline')):
                first = save_run_to_db(RUN, directory, {'DB_UPLOAD_ENABLED': 'true'})
            self.assertTrue(json.loads(Path(first['file']).read_text())['pending'])
            with patch('save_run.upload_run'):
                second = save_run_to_db(RUN, directory, {'DB_UPLOAD_ENABLED': 'true'})
            self.assertEqual(first['file'], second['file'])
            self.assertFalse(json.loads(Path(second['file']).read_text())['pending'])

    def test_snapshot_views_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'snapshot.db'
            snapshot([RUN], file)
            with closing(sqlite3.connect(file)) as db:
                self.assertEqual(db.execute('select generated,executed,failed from mobile_b_runs').fetchone(), (1, 1, 1))
                self.assertEqual(db.execute('select count(*) from web_a_runs').fetchone()[0], 0)
            with self.assertRaises(ValueError):
                snapshot([RUN], file)

    def test_incomplete_not_successful(self):
        with self.assertRaises(ValueError):
            validate(dict(RUN, execution_results=[]))
        validate(dict(RUN, execution_state='incomplete', execution_results=[]))

    def test_metadata_roundtrip_in_offline_summary(self):
        run = dict(RUN, model='test-model', exploration_stop_reason='step_budget', exploration_complete=False)
        with tempfile.TemporaryDirectory() as directory:
            saved = save_run_to_db(run, directory, {})
            self.assertIs(json.loads(Path(saved['file']).read_text())['run']['run_details']['exploration_complete'], False)
            file = Path(directory)/'snapshot.db'
            snapshot([run], file)
            with closing(sqlite3.connect(file)) as db:
                row = db.execute('select model,exploration_stop_reason,exploration_complete,generated,failed from mobile_b_runs').fetchone()
                self.assertEqual(row, ('test-model', 'step_budget', 0, 1, 1))

    def test_legacy_provenance_stays_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory)/'legacy.db'
            snapshot([RUN], file)
            with closing(sqlite3.connect(file)) as db:
                self.assertEqual(db.execute('select model,exploration_stop_reason,exploration_complete from mobile_b_runs').fetchone(), (None, None, None))

    def test_metadata_types_are_validated(self):
        for fields in ({'model': ''}, {'model': 123}, {'exploration_complete': 'false'}, {'exploration_stop_reason': True}):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                validate(dict(RUN, **fields))

    def test_flat_queued_metadata_uses_existing_json_column(self):
        run = dict(RUN, model='recorded-model', exploration_stop_reason='step_budget', exploration_complete=False,
                   run_details={'version': 1, 'pages': 3, 'llm': {'provider': 'openai'}})
        normalized = validate(run)
        self.assertNotIn('model', normalized)
        self.assertNotIn('exploration_stop_reason', normalized)
        self.assertNotIn('exploration_complete', normalized)
        self.assertEqual(normalized['run_details'], {'version': 1, 'pages': 3,
            'llm': {'provider': 'openai', 'model': 'recorded-model'},
            'stop_reason': 'step_budget', 'exploration_complete': False})
        self.assertEqual(validate(normalized), normalized)
        self.assertNotIn('model', run['run_details']['llm'])  # input is not mutated

    def test_conflicting_and_malformed_details_are_rejected(self):
        for fields in ({'run_details': []}, {'run_details': {'llm': []}},
                       {'model': 'new', 'run_details': {'llm': {'model': 'original'}}}):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                validate(dict(RUN, **fields))

    def test_http_diagnostics_expose_status_code_without_credentials_or_row(self):
        body = io.BytesIO(json.dumps({'code': 'PGRST204', 'message': 'private row contents'}).encode())
        error = HTTPError('https://example.supabase.co', 400, 'Bad Request', {}, body)
        with patch('save_run.urlopen', side_effect=error):
            with self.assertRaises(SupabaseHTTPError) as raised:
                request('GET', 'runs', env={'SUPABASE_URL': 'https://example.supabase.co', 'SUPABASE_SERVICE_ROLE_KEY': 'private-key'})
        self.assertIn('HTTP 400 (PGRST204)', str(raised.exception))
        self.assertNotIn('private', str(raised.exception))

if __name__ == '__main__':
    unittest.main()
