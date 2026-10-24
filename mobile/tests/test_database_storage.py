import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.database_storage import MobileRun, normalize_results, write_exploration_metadata, read_exploration_metadata
from database.save_run import save_run_to_db


class MobileStorageTests(unittest.TestCase):
    def session(self):
        return MobileRun("B", "settings", "settings-01", [], [{"id": "TC001"}])

    def test_both_executor_formats(self):
        results = normalize_results([
            {"test_case": "A", "status": "PASS", "execution_time": "1.25s"},
            {"test_case": "B", "status": "FAIL", "execution_time_seconds": 2.5, "error": "missing"},
        ])
        self.assertEqual([r["duration_ms"] for r in results], [1250, 2500])
        self.assertEqual([r["status"] for r in results], ["passed", "failed"])
        self.assertEqual(results[1]["error"], "missing")

    def test_failed_suite_is_completed_and_saved_offline(self):
        with tempfile.TemporaryDirectory() as directory:
            def save(run):
                return save_run_to_db(run, directory, {"DB_UPLOAD_ENABLED": "false"})
            session = self.session()
            with patch("src.database_storage.save_run_to_db", side_effect=save):
                initial = session.save([])
                final = session.save([{"test_case": "TC001", "status": "FAIL"}], finished=True)
            self.assertEqual(initial["file"], final["file"])
            bundle = json.loads(Path(final["file"]).read_text())
            self.assertTrue(bundle["pending"])
            self.assertEqual(bundle["run"]["execution_state"], "completed")
            self.assertEqual(bundle["run"]["execution_results"][0]["status"], "failed")

    def test_partial_and_empty_suites_stay_incomplete(self):
        with patch("src.database_storage.save_run_to_db", return_value={"file": "test", "uploaded": True}):
            session = self.session()
            session.save([], finished=True)
            self.assertEqual(session.run["execution_state"], "incomplete")
            session = MobileRun("A", "settings", "pair", [], [])
            session.save([], finished=True)
            self.assertEqual(session.run["execution_state"], "incomplete")

    def test_rejects_unknown_status_and_duplicate_results(self):
        with tempfile.TemporaryDirectory() as directory:
            session = self.session()
            for results in ([{"test_case": "TC001", "status": "UNKNOWN"}],
                            [{"test_case": "TC001", "status": "PASS"}] * 2):
                session.run["execution_results"] = normalize_results(results)
                with self.assertRaises(ValueError):
                    save_run_to_db(session.run, directory, {})

    def test_architectures_share_comparison_but_have_distinct_run_ids(self):
        a = MobileRun("A", "settings", "pair", [], [{"test_case_id": "TC001"}])
        b = MobileRun("B", "settings", "pair", [], [{"id": "TC001"}])
        self.assertEqual(a.run["comparison_id"], b.run["comparison_id"])
        self.assertNotEqual(a.run["run_id"], b.run["run_id"])
        self.assertEqual(a.run["test_cases"][0]["id"], "TC001")

    def test_exploration_metadata_survives_completed_execution(self):
        metadata = dict(model='recorded-model', exploration_complete=False, exploration_stop_reason='rate_limit')
        session = MobileRun('B', 'settings', 'pair', [], [{'id': 'TC001'}], metadata=metadata)
        with patch('src.database_storage.save_run_to_db', return_value={'file': 'test', 'uploaded': True}):
            session.save([{'test_case': 'TC001', 'status': 'PASS'}], finished=True)
        self.assertEqual(session.run['execution_state'], 'completed')
        self.assertEqual(session.run['run_details']['llm']['model'], 'recorded-model')
        self.assertIs(session.run['run_details']['exploration_complete'], False)
        self.assertEqual(session.run['run_details']['stop_reason'], 'rate_limit')

    def test_replay_metadata_matches_selected_history(self):
        metadata = dict(model='original-model', exploration_complete=False, exploration_stop_reason='step_budget')
        with tempfile.TemporaryDirectory() as directory:
            memory = [{'step': 1}]
            write_exploration_metadata(directory, memory, metadata)
            self.assertEqual(read_exploration_metadata(directory, memory), metadata)
            with self.assertRaisesRegex(ValueError, 'does not match'):
                read_exploration_metadata(directory, [{'step': 2}])
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(read_exploration_metadata(directory, memory), {})

    def test_result_attachments_are_preserved(self):
        result = normalize_results([{'test_case': 'TC001', 'status': 'PASS', 'attachments': [{'path': 'local.png'}]}])[0]
        self.assertEqual(result['attachments'], [{'path': 'local.png'}])

    def test_vision_executor_preserves_partial_results_on_crash(self):
        from vision.vision_test_executor import execute_all
        from unittest.mock import Mock
        session = Mock()
        first = {"test_case": "TC001", "status": "PASS"}
        with tempfile.TemporaryDirectory() as directory:
            with patch("vision.vision_test_executor.execute_test",
                       side_effect=[first, RuntimeError("interrupted")]):
                with self.assertRaisesRegex(RuntimeError, "interrupted"):
                    execute_all(None, [{"id": "TC001"}, {"id": "TC002"}],
                                Path(directory), "settings", database_session=session)
        session.save.assert_called_once_with([first], finished=False)

    def test_a_connection_failure_leaves_incomplete_bundle(self):
        import run_pipeline
        from unittest.mock import Mock
        session = Mock()
        with patch.object(sys, "argv", ["run_pipeline.py", "--comparison", "pair"]), \
             patch.object(run_pipeline, "load_log", return_value=[{"step": 1}]), \
             patch.object(run_pipeline, "generate_test_cases", return_value=[{"id": "TC001"}]), \
             patch.object(run_pipeline, "generate_script"), \
             patch.object(run_pipeline, "MobileRun", return_value=session), \
             patch.object(run_pipeline, "build_driver", side_effect=RuntimeError("offline")):
            with self.assertRaisesRegex(RuntimeError, "offline"):
                run_pipeline.main()
        self.assertEqual(session.save.call_count, 2)
        session.save.assert_called_with([], finished=False)


if __name__ == "__main__":
    unittest.main()
