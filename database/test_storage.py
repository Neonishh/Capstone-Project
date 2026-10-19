import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch
from save_run import save_run_to_db, validate
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

if __name__ == '__main__':
    unittest.main()
