import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vision.quality import Coverage, requirement_cases
from vision.test_case_generator import generate_test_cases
from vision.vision_test_executor import _check_oracle, execute_test


class QualityTests(unittest.TestCase):
    def test_actions_are_scoped_to_screen(self):
        coverage = Coverage()
        elements = [{"text": text, "clickable": True, "bbox": [0, i*20, 10, i*20+10]}
                    for i, text in enumerate(["Open", "Other"])]
        action = dict(action="tap", element_index=0, target="Open", bbox=elements[0]["bbox"])
        self.assertEqual(coverage.choose("a", action, elements)["element_index"], 0)
        self.assertEqual(coverage.choose("a", action, elements)["element_index"], 1)
        self.assertEqual(coverage.choose("b", action, elements)["element_index"], 0)

    def test_state_oracle_rejects_label_only_and_ambiguity(self):
        test = {"verification": {"type": "control_state", "target": {"text": "Wi-Fi"}, "checked": True}}
        self.assertFalse(_check_oracle(test, {}, [{"text": "Wi-Fi"}], {})[0])
        element = {"text": "Wi-Fi", "checkable": True, "checked": True}
        self.assertTrue(_check_oracle(test, {}, [element], {})[0])
        self.assertFalse(_check_oracle(test, {}, [element, element], {})[0])
        self.assertFalse(_check_oracle({}, {}, [], {"changed": True})[0])

    def test_duplicate_transition_and_shortest_setup(self):
        def entry(source, destination, label):
            return {"action": "tap", "screen_key": source, "target": label,
                    "target_control": {"clickable": True, "text": label},
                    "execution": {"status": "executed", "screen_key_after": destination,
                                  "destination_titles": [destination], "verification": {"changed": True}}}
        history = [entry("root", "child", "Open"), entry("child", "root", "Back"),
                   entry("root", "child", "Open"), entry("root", "other", "Other")]
        with tempfile.TemporaryDirectory() as directory:
            cases, _ = generate_test_cases(history, Path(directory)/"cases.json")
        self.assertEqual(len(cases), 3)
        self.assertEqual(cases[-1]["setup"], [])
        self.assertEqual(len(cases[-1]["steps"]), 1)

    def test_toggle_fixture_and_cleanup(self):
        entry = {"action": "tap", "screen_key": "root", "target": "Wi-Fi",
                 "target_control": {"text": "Wi-Fi", "clickable": True, "checkable": True, "checked_before": False},
                 "execution": {"status": "executed", "controls_after": [{"text": "Wi-Fi", "checkable": True, "checked": True}],
                               "verification": {"changed": True}}}
        with tempfile.TemporaryDirectory() as directory:
            cases, _ = generate_test_cases([entry], Path(directory)/"cases.json")
        self.assertFalse(cases[0]["setup"][0]["checked"])
        self.assertEqual(cases[0]["cleanup"], cases[0]["setup"])
        self.assertTrue(cases[0]["verification"]["checked"])

    def test_cleanup_runs_after_failure_and_reports_failure(self):
        with tempfile.TemporaryDirectory() as directory, patch(
            "vision.vision_test_executor.launch_start", side_effect=RuntimeError("launch failed")
        ) as launch:
            result = execute_test(Mock(), {"id": "broken", "steps": [{"action": "back"}],
                                          "cleanup": [{"action": "back"}]}, Path(directory), 1, "app")
        self.assertEqual(launch.call_count, 2)
        self.assertEqual(result["status"], "FAIL")
        self.assertEqual(result["cleanup"]["status"], "FAIL")

    def test_requirement_needs_explicit_expected_outcome(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/"requirements.json"
            path.write_text(json.dumps([{"id": "login", "scenarios": [
                {"id": "invalid", "category": "invalid", "steps": [{"action": "back"}]}
            ]}]))
            with self.assertRaises(ValueError):
                requirement_cases(path)

    def test_example_covers_all_requirement_categories(self):
        cases = requirement_cases(Path(__file__).resolve().parents[1]/"vision"/"requirements.example.json")
        self.assertEqual({case["category"] for case in cases},
                         {"valid", "invalid", "boundary", "cancellation", "persistence"})

    def test_exploration_replaces_uncontrolled_input_with_replayable_synthetic_data(self):
        elements = [{"text": "Name", "editable": True, "clickable": True, "bbox": [0,0,10,10]},
                    {"text": "Open", "clickable": True, "bbox": [0,20,10,30]}]
        chosen = Coverage().choose("screen", {"action": "type", "element_index": 0, "value": "uncontrolled"}, elements)
        self.assertEqual(chosen["action"], "type")
        self.assertEqual(chosen["input_fixture"], "text")
        self.assertEqual(chosen["value"], "QA sample 42")
        self.assertTrue(chosen["clear"])
