"""Regressions exposed by the 20261022_172453_558195Z Settings run."""
import copy
import json
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vision.quality import Coverage, action_key, exploration_target, screen_key, wait_for_screen
from vision.test_case_generator import generate_test_cases
from vision.vision_test_executor import _check_oracle
from vision.vision_merger import merge
from vision import explore_vision as runner


def transition(label="Open", destination="Feature"):
    return {"step": 1, "screen_key": "root", "activity_before": ".Settings", "action": "tap",
            "target_control": {"text": label, "resource_id": "app:id/row", "clickable": True},
            "execution": {"status": "executed", "activity_after": ".Feature",
                          "screen_key_after": "feature", "in_scope": True,
                          "destination_titles": [destination], "visible_text_after": [destination],
                          "verification": {"changed": True, "new_text": [destination.casefold()]}}}


class RunRegressions(unittest.TestCase):
    def generate(self, history):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"cases.json"
            cases, _ = generate_test_cases(history, path)
            review = json.loads(path.with_name("generation_review.json").read_text())
        return cases, review

    def test_loading_message_is_neither_case_nor_setup(self):
        loading = transition("Sign in", "Checking info\u2026")
        next_action = transition("Next", "Sign in")
        next_action["screen_key"] = "unknown-login-screen"
        cases, review = self.generate([loading, next_action])
        self.assertEqual(cases, [])
        self.assertEqual(review["excluded"][0]["reason"], "transient_or_unsettled_destination")

    def test_duplicate_behavior_ignores_coordinates_and_viewport_signature(self):
        first = transition("Sign in", "Your account")
        other = copy.deepcopy(first)
        other["screen_key"] = "root-with-shifted-summary"
        other["target_control"]["norm_center"] = [0.5, 0.7]
        cases, review = self.generate([first, other])
        self.assertEqual(len(cases), 1)
        self.assertIn("duplicate_behavior", [item["reason"] for item in review["excluded"]])

    def test_different_controls_with_shared_resource_id_survive(self):
        cases, _ = self.generate([transition("Wi-Fi", "Internet"), transition("Bluetooth", "Connected devices")])
        self.assertEqual(len(cases), 2)

    def test_external_transition_is_excluded(self):
        entry = transition()
        entry["execution"]["in_scope"] = False
        self.assertEqual(self.generate([entry])[0], [])

    def test_back_label_alone_is_not_an_assertion(self):
        self.assertEqual(self.generate([transition("Search settings", "Back")])[0], [])

    def test_search_requires_editable_control_when_no_title(self):
        entry = transition("Search settings", "Back")
        entry["execution"]["controls_after"] = [{"resource_id": "search:id/query", "editable": True}]
        cases, _ = self.generate([entry])
        oracle = cases[0]["verification"]
        self.assertEqual(oracle["type"], "control_present")
        self.assertFalse(_check_oracle({"verification": oracle}, {}, [], {}, ".Feature")[0])
        self.assertTrue(_check_oracle({"verification": oracle}, {}, entry["execution"]["controls_after"], {}, ".Feature")[0])

    def test_fingerprints_ignore_keyboard_clock_summaries_and_shift(self):
        original = [{"text": "Apps", "resource_id": "android:id/title", "bbox": [0, 10, 100, 50]}]
        shifted = copy.deepcopy(original)
        shifted[0]["bbox"] = [0, 20, 100, 60]
        shifted += [{"text": "23:01"}, {"text": "New summary", "resource_id": "app:id/summary"},
                    {"text": "GIF", "package": "com.google.android.inputmethod.latin"}]
        self.assertEqual(screen_key(original, ".Settings"), screen_key(shifted, ".Settings"))
        self.assertEqual(action_key({"action": "tap", "element_index": 0}, original),
                         action_key({"action": "tap", "element_index": 0}, shifted))

    def test_controller_rejects_loading_editable_and_out_of_scope_targets(self):
        element = {"text": "Checking info\u2026", "clickable": True, "bbox": [0, 0, 10, 10], "package": "app"}
        self.assertFalse(exploration_target(element, "app"))
        element["text"] = "Name"
        element["editable"] = True
        self.assertFalse(exploration_target(element, "app"))
        element["editable"] = False
        element["package"] = "external"
        self.assertFalse(exploration_target(element, "app"))

    def test_recovery_is_bounded_and_preserves_visit_totals(self):
        coverage = Coverage()
        for _ in range(3):
            coverage.record(False)
        self.assertEqual(coverage.recovery("a", "app", {"app"}), "three_actions_without_progress")
        coverage.recovered("a")
        self.assertIsNone(coverage.recovery("a", "app", {"app"}))
        self.assertEqual(coverage.recovery("a", "external", {"app"}), "outside_app_scope")

    def test_settle_waits_past_loading_and_stops_on_timeout(self):
        driver = Mock(current_activity=".Feature", current_package="app")
        ready = [{"text": "Feature"}]
        with patch("vision.quality.time.sleep"):
            observe = Mock(side_effect=[[{"text": "Checking info\u2026"}], ready, ready])
            elements, detail = wait_for_screen(driver, observe)
        self.assertTrue(detail["settled"])
        self.assertEqual(elements, ready)
        with patch("vision.quality.time.monotonic", side_effect=[0, 5]):
            _, detail = wait_for_screen(driver, Mock(return_value=[{"text": "Loading"}]))
        self.assertFalse(detail["settled"])

    def test_merger_preserves_class_and_package_for_overlapping_detections(self):
        element = {"text": "Choice", "bbox": [0, 0, 100, 100], "clickable": True,
                   "control_class": "android.widget.RadioButton", "package": "app"}
        with tempfile.TemporaryDirectory() as directory:
            merged = merge(1, "unused.png", [], [{"text": "Choice", "bbox": element["bbox"]}], directory, [element])
        target = merged["elements"][0]
        self.assertEqual(target["control_class"], element["control_class"])
        self.assertEqual(target["package"], "app")
        self.assertFalse(exploration_target(target, "app"))

    def run_mocked_explorer(self, wait_result=None, wait_error=None):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            root = Path(directory)
            for name, value in {"VISION_DIR": root, "SCREENSHOTS_DIR": root/"screenshots",
                                "JSON_DIR": root/"json", "DEBUG_DIR": root/"debug",
                                "MEMORY_LOG_PATH": str(root/"vision_memory_log.json")}.items():
                stack.enter_context(patch.object(runner, name, value))
            stack.enter_context(patch.dict("os.environ", {"LLM_PROVIDER": "openai", "OPENAI_MODEL": "configured-model"}))
            stack.enter_context(patch.object(sys, "argv", ["explore_vision.py", "--max-steps", "1", "--app-package", "app"]))
            stack.enter_context(patch.object(runner, "build_driver", return_value=Mock(current_package="external", current_activity=".Login")))
            stack.enter_context(patch.object(runner, "launch_start"))
            stack.enter_context(patch.object(runner, "wait_for_screen", return_value=wait_result, side_effect=wait_error))
            model = stack.enter_context(patch.object(runner, "decide_next_action"))
            code = runner.main()
            return code, model.call_count, json.loads((root/"run_config.json").read_text()), json.loads((root/"run_summary.json").read_text())

    def test_scope_recovery_happens_before_model_and_preserves_metadata(self):
        code, calls, config, summary = self.run_mocked_explorer(wait_result=([{"text": "Sign in"}], {"settled": True}))
        self.assertEqual(code, 0)
        self.assertEqual(calls, 0)
        self.assertEqual(config["model"], "configured-model")
        self.assertEqual(summary["model"], "configured-model")
        self.assertEqual(summary["exploration_stop_reason"], "step_budget")
        self.assertIs(summary["exploration_complete"], False)
        self.assertEqual(summary["coverage"]["recoveries"], 1)

    def test_fatal_exploration_is_not_reported_as_success(self):
        code, _, _, summary = self.run_mocked_explorer(wait_error=RuntimeError("device disconnected"))
        self.assertEqual(code, 1)
        self.assertEqual(summary["exploration_status"], "failed")
        self.assertEqual(summary["exploration_stop_reason"], "error")
        self.assertIn("device disconnected", summary["exploration_error"])
