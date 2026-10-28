import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vision.coordinate_mapper import map_bbox_center
from vision.target_matcher import resolve_target
from vision.test_case_generator import generate_test_cases
from vision.vision_test_executor import _check_oracle
from vision.app_state import launch_start
from vision.action_verification import verify_action


class ReplayTests(unittest.TestCase):
    def test_unknown_title_is_not_evidence_of_navigation(self):
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "same.png"
            Image.new("RGB", (100, 200)).save(image)
            result = verify_action(image, image, "Settings", "unknown", [], [])
        self.assertFalse(result["changed"])

    def test_system_bars_do_not_compress_coordinates(self):
        driver = Mock()
        driver.execute_script.side_effect = RuntimeError("unsupported")
        driver.get_window_size.return_value = {"width": 1080, "height": 2209}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "screen.png"
            Image.new("RGB", (1080, 2400)).save(path)
            result = map_bbox_center(driver, path, [0, 800, 1080, 1000])
        self.assertEqual(result["device_point"], [540, 900])

    def test_shared_resource_id_does_not_override_wrong_text(self):
        elements = [{"text": "Bluetooth", "resource_id": "android:id/title",
                     "clickable": True, "bbox": [0, 0, 100, 100]}]
        element, _ = resolve_target({"text": "Internet", "resource_id": "android:id/title"},
                                    elements, (1080, 2400), "tap")
        self.assertIsNone(element)

    def test_all_expected_text_and_activity_are_required(self):
        test = {"verification": {"type": "postcondition", "texts": ["Internet", "Wi-Fi"],
                                 "activity": ".Settings"}}
        self.assertFalse(_check_oracle(test, {}, [{"text": "Internet"}], {}, ".Settings")[0])
        self.assertTrue(_check_oracle(test, {}, [{"text": "Internet"}, {"text": "Wi-Fi"}], {}, ".Settings")[0])

    def test_fallback_actions_are_not_generated_as_llm_tests(self):
        entry = {"reason": "fallback_after_llm_error", "action": "tap",
                 "execution": {"status": "executed", "verification": {"changed": True}}}
        with tempfile.TemporaryDirectory() as directory:
            cases, _ = generate_test_cases([entry], Path(directory) / "cases.json")
        self.assertEqual(cases, [])

    def test_reset_launches_explicit_activity(self):
        from unittest.mock import patch
        driver = Mock()
        with patch("vision.app_state.time.sleep"):
            launch_start(driver, "com.android.settings", ".Settings")
        options = driver.execute_script.call_args.args[1]
        self.assertEqual(options["component"], "com.android.settings/.Settings")
        self.assertTrue(options["stop"])

    def test_generated_case_asserts_recorded_destination(self):
        entry = {"step": 1, "action": "tap", "target": "Internet", "reason": "explore",
                 "target_control": {"clickable": True, "text": "Internet"},
                 "execution": {"status": "executed", "activity_after": ".SubSettings",
                               "visible_text_after": ["Add network"],
                               "verification": {"changed": True, "new_text": ["add network"]}}}
        with tempfile.TemporaryDirectory() as directory:
            cases, _ = generate_test_cases([entry], Path(directory) / "cases.json")
        self.assertEqual(cases[0]["verification"], {"type": "postcondition", "texts": ["Add network"],
                                                   "activity": ".SubSettings"})

    def test_radio_case_asserts_selected_value(self):
        entry = {"step": 1, "action": "tap", "target": "Treat as metered", "reason": "explore",
                 "target_control": {"clickable": True, "checkable": True},
                 "execution": {"status": "executed", "selected_value_after": "Treat as metered",
                               "verification": {"changed": True}}}
        with tempfile.TemporaryDirectory() as directory:
            cases, _ = generate_test_cases([entry], Path(directory) / "cases.json")
        self.assertEqual(cases, [])  # Label-only evidence cannot establish selected state.

    def test_navigation_prefers_destination_title_to_mutable_summary(self):
        entry = {"action": "tap", "target": "Settings", "reason": "explore",
                 "target_control": {"clickable": True},
                 "execution": {"status": "executed", "destination_titles": ["Network details"],
                               "visible_text_after": ["Detect automatically"],
                               "verification": {"changed": True, "new_text": ["detect automatically"]}}}
        with tempfile.TemporaryDirectory() as directory:
            cases, _ = generate_test_cases([entry], Path(directory) / "cases.json")
        self.assertEqual(cases[0]["verification"]["texts"], ["Network details"])


if __name__ == "__main__":
    unittest.main()
