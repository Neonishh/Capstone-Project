"""Functional coverage regressions: inputs, complete workflows, exact assertions and breadth."""
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from contextlib import ExitStack

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vision.accessibility_extractor import extract_accessibility
from vision.behavior_planner import BehaviorPlanner
from vision.behavior_profiles import wdio_cases
from vision.input_data import controlled_type, read_step_value
from vision.oracles import check_oracle
from vision.quality import Coverage, input_target
from vision.quality import wait_for_screen
from vision.target_matcher import resolve_target
from vision.test_case_generator import generate_test_cases
from vision import explore_vision as runner


class FunctionalExplorationTests(unittest.TestCase):
    def test_input_locator_is_stable_after_typing_and_inherits_native_test_id(self):
        xml = '<hierarchy><node content-desc="input-email" bounds="[0,0][100,100]" displayed="true"><node class="android.widget.EditText" text="qa.mobile@example.com" hint="Email" bounds="[10,10][90,90]" displayed="true" editable="true" /></node></hierarchy>'
        field = next(e for e in extract_accessibility(Mock(page_source=xml)) if e["editable"])
        self.assertEqual(field["accessibility_id"], "input-email")
        self.assertEqual(field["text"], "input-email")
        self.assertEqual(field["value"], "qa.mobile@example.com")
        self.assertEqual(field["bbox"], [10,10,90,90])

    def test_password_content_is_redacted_without_redacting_its_locator(self):
        xml = '<hierarchy><node class="android.widget.EditText" content-desc="input-password" text="secret" password="true" bounds="[0,0][100,100]" displayed="true" /></hierarchy>'
        field = extract_accessibility(Mock(page_source=xml))[0]
        self.assertEqual(field["accessibility_id"], "input-password")
        self.assertEqual(field["value"], "[REDACTED]")
        self.assertNotIn("secret", json.dumps(field))

    def test_controller_uses_matching_synthetic_values_instead_of_model_passwords(self):
        action = controlled_type({"value": "real-secret"}, {"accessibility_id": "input-password"})
        confirm = controlled_type({}, {"accessibility_id": "input-repeat-password", "password": True})
        self.assertEqual(action["value"], confirm["value"])
        self.assertNotEqual(action["value"], "real-secret")
        self.assertTrue(action["clear"])
        self.assertEqual(read_step_value({"input_fixture": "empty", "value": "must-not-win"}), "")

    def test_unknown_fixture_is_rejected(self):
        with self.assertRaises(ValueError):
            read_step_value({"input_fixture": "unknown"})

    def test_slow_first_snapshot_gets_one_confirmation_instead_of_false_instability(self):
        observe = Mock(return_value=[{"text": "Congratulations"}])
        with patch("vision.quality.time.monotonic", side_effect=[0,5]), patch("vision.quality.time.sleep"):
            _, detail = wait_for_screen(Mock(current_activity=".Main", current_package="app"), observe)
        self.assertTrue(detail["settled"])
        self.assertEqual(observe.call_count, 2)

    def test_private_account_references_do_not_mutate_the_saved_step(self):
        step = {"value_env": "MOBILE_TEST_PASSWORD"}
        with patch.dict("os.environ", {"MOBILE_TEST_PASSWORD": "private-test-account-value"}):
            self.assertEqual(read_step_value(step), "private-test-account-value")
        self.assertEqual(step, {"value_env": "MOBILE_TEST_PASSWORD"})
        with self.assertRaises(ValueError): read_step_value({"value_env": "OPENAI_API_KEY"})

    def test_duplicate_labels_for_the_same_physical_button_do_not_create_ambiguity(self):
        button = {"accessibility_id": "submit", "bbox": [0,0,100,30], "clickable": True, "text": "Submit"}
        alias = {**button, "text": "button-submit"}
        self.assertIsNotNone(resolve_target({"accessibility_id": "submit"}, [button, alias], (100,100), "tap")[0])

    def test_dropdown_value_uses_the_editable_child_not_its_wrapper(self):
        elements = [{"accessibility_id": "Dropdown", "editable": editable, "value": "Appium is awesome"} for editable in (False, True)]
        oracle = {"verification": {"type": "control_value", "target": {"accessibility_id": "Dropdown", "editable": True}, "value": "Appium is awesome"}}
        self.assertTrue(check_oracle(oracle, {}, elements, {})[0])

    def test_editability_oracle_disambiguates_native_field_from_its_wrapper(self):
        elements = [{"accessibility_id": "email", "editable": editable} for editable in (False, True)]
        oracle = {"verification": {"type": "control_present", "target": {"accessibility_id": "email"}, "editable": True}}
        self.assertTrue(check_oracle(oracle, {}, elements, {})[0])

    def test_shared_resource_ids_do_not_confuse_email_and_password(self):
        elements = [{"resource_id": "shared", "accessibility_id": name, "editable": True, "bbox": [0,i*20,100,i*20+10]}
                    for i,name in enumerate(["input-email", "input-password"])]
        field, _ = resolve_target({"accessibility_id": "input-password"}, elements, (100,100), "type")
        self.assertEqual(field["accessibility_id"], "input-password")
        field, _ = resolve_target({"accessibility_id": "missing"}, elements, (100,100), "type")
        self.assertIsNone(field)

    def test_picker_can_be_tapped_but_is_not_treated_as_a_typable_field(self):
        dropdown = {"accessibility_id": "Dropdown", "editable": True, "focusable": False, "clickable": False, "bbox": [0,0,100,30]}
        self.assertFalse(input_target(dropdown))
        self.assertIsNotNone(resolve_target({"accessibility_id": "Dropdown"}, [dropdown], (100,100), "tap")[0])

    def test_fresh_main_feature_wins_over_repeated_login_navigation(self):
        elements = [{"text": name, "accessibility_id": name, "clickable": True, "bbox": [i*20,80,i*20+15,100]}
                    for i,name in enumerate(["Login", "Forms", "Swipe"])]
        coverage = Coverage()
        login = {"action": "tap", "element_index": 0, "target": "Login"}
        self.assertEqual(coverage.choose("home", login, elements)["target"], "Login")
        self.assertEqual(coverage.choose("another-screen", login, elements)["target"], "Forms")

    def test_control_value_assertion_is_exact_and_cannot_pass_using_only_a_label(self):
        test = {"verification": {"type": "control_value", "target": {"accessibility_id": "input"}, "input_fixture": "text"}}
        self.assertFalse(check_oracle(test, {}, [{"accessibility_id": "input", "text": "QA sample 42"}], {})[0])
        self.assertFalse(check_oracle(test, {}, [{"accessibility_id": "input", "value": "QA sample"}], {})[0])
        self.assertTrue(check_oracle(test, {}, [{"accessibility_id": "input", "value": "QA sample 42"}], {})[0])
        self.assertFalse(check_oracle(test, {}, [{"accessibility_id": "input", "value": "QA sample 42"}] * 2, {})[0])

    def test_absence_oracle_requires_the_expected_message_to_be_gone(self):
        test = {"verification": {"type": "text_absent", "texts": ["Success"]}}
        self.assertFalse(check_oracle(test, {}, [{"text": "Success"}], {})[0])
        self.assertTrue(check_oracle(test, {}, [{"text": "Login"}], {})[0])
        self.assertFalse(check_oracle({"verification": {"type": "all", "conditions": []}}, {}, [], {})[0])

    def test_carousel_assertion_rejects_a_clipped_adjacent_card_title(self):
        test = {"verification": {"type": "text_in_view", "text": "Great community", "min_width_fraction": 0.4}}
        clipped = [{"text": "GREAT COMMUNITY", "bbox": [996,100,1080,160]}]
        centered = [{"text": "GREAT COMMUNITY", "bbox": [100,100,800,160]}]
        self.assertFalse(check_oracle(test, {"viewport_width": 1080}, clipped, {})[0])
        self.assertTrue(check_oracle(test, {"viewport_width": 1080}, centered, {})[0])

    def test_typing_clears_instead_of_appending_and_dismisses_the_keyboard(self):
        driver = Mock()
        driver.is_keyboard_shown.return_value = True
        with patch.object(runner, "map_bbox_center", return_value={"screenshot_point": [5,5], "device_point": [5,5], "aspect_ratio_mismatch": False}), patch.object(runner, "annotate_tap"), patch.object(runner.time, "sleep"):
            result = runner.execute_action(driver, {"action": "type", "bbox": [0,0,10,10], "_screenshot_path": "fixture.png", "value": "replacement", "clear": True})
        self.assertEqual(result["status"], "executed")
        driver.switch_to.active_element.clear.assert_called_once()
        driver.switch_to.active_element.send_keys.assert_called_once_with("replacement")
        driver.hide_keyboard.assert_called_once()

    def test_swipe_directions_are_explicit(self):
        driver = Mock(); driver.get_window_size.return_value = {"width": 100, "height": 200}
        runner._do_swipe(driver, "left")
        self.assertEqual(driver.swipe.call_args.args, (85,100,15,100))
        with self.assertRaises(ValueError): runner._do_swipe(driver, "unknown")
        runner._do_swipe(driver, "up", [0.1,0,0.8,0.55], 180)
        self.assertLess(driver.swipe.call_args.args[1], 100)  # Gesture starts above the horizontal carousel.
        with self.assertRaises(ValueError): runner._do_swipe(driver, "up", [0,0,1,2])

    def test_profile_contains_independent_form_auth_and_gesture_behaviors(self):
        cases = wdio_cases()
        self.assertEqual(len({c["id"] for c in cases}), len(cases))
        self.assertTrue({"valid", "invalid", "boundary", "cancellation", "persistence", "gesture", "state", "selection"}.issubset({c["category"] for c in cases}))
        for case in cases:
            self.assertEqual(case["source"]["kind"], "app_profile")
            self.assertEqual(case["cleanup"], [{"action": "relaunch"}])
        self.assertEqual(len(next(c for c in cases if c["id"].endswith("drag-puzzle"))["steps"]), 9)

    def test_planner_never_emits_an_unfinished_workflow_as_a_test(self):
        planner = BehaviorPlanner("com.wdiodemoapp", ".MainActivity")
        action = planner.next_action([], (100,100))
        self.assertEqual(action["action"], "relaunch")
        planner.record(action, {"status": "executed"}, 1)
        self.assertEqual(planner.completed, [])
        self.assertEqual(planner.summary()["partial_scenario"], "BEH-WDIO-input-echo")

    def test_planner_preserves_completed_failures_for_replay_instead_of_hiding_them(self):
        planner = BehaviorPlanner("com.wdiodemoapp", ".MainActivity")
        planner.pending[0]["setup"] = []
        planner.pending[0]["steps"] = [{"action": "observe"}]
        action = planner.next_action([], (100,100)); planner.record(action, {"status": "executed"}, 1)
        action = planner.next_action([], (100,100)); planner.record(action, {"status": "executed"}, 2, {"ok": False})
        self.assertEqual(len(planner.completed), 1)
        self.assertFalse(planner.completed[0]["source"]["exploration_assertion"]["ok"])

    def test_generic_apps_do_not_receive_wdio_scenarios(self):
        planner = BehaviorPlanner("another.app", ".MainActivity")
        self.assertIsNone(planner.next_action([], (100,100)))
        self.assertEqual(planner.completed, [])

    def test_fixture_typed_steps_survive_generation_and_remain_submission_setup(self):
        history = [
            {"step": 1, "action": "type", "state_key": "empty-form", "screen_key": "form", "value": "[REDACTED]", "input_fixture": "email",
             "target_control": {"editable": True, "clickable": True, "accessibility_id": "input-email", "text": "Email"},
             "execution": {"status": "executed", "state_key_after": "filled-form", "screen_key_after": "form", "controls_after": [], "verification": {"changed": True}}},
            {"step": 2, "action": "tap", "state_key": "filled-form", "screen_key": "form", "activity_before": ".MainActivity",
             "target_control": {"clickable": True, "text": "Submit"},
             "execution": {"status": "executed", "state_key_after": "success", "destination_titles": ["Success"], "verification": {"changed": True}}}
        ]
        with tempfile.TemporaryDirectory() as directory:
            cases, _ = generate_test_cases(history, Path(directory)/"cases.json")
        submit = next(c for c in cases if c["steps"][0]["action"] == "tap")
        self.assertEqual(submit["setup"][0]["input_fixture"], "email")
        self.assertEqual(cases[0]["verification"]["type"], "control_value")
        self.assertNotIn("[REDACTED]", json.dumps(cases))

    def test_profile_action_history_does_not_duplicate_a_complete_functional_case(self):
        entry = {"behavior_id": "BEH-WDIO-login-valid", "action": "tap", "target_control": {"clickable": True, "text": "Login"},
                 "execution": {"status": "executed", "destination_titles": ["Success"], "verification": {"changed": True}}}
        with tempfile.TemporaryDirectory() as directory:
            cases, _ = generate_test_cases([entry], Path(directory)/"cases.json")
        self.assertEqual(cases, [])

    def test_profile_pipeline_finalizes_and_preserves_policy_in_database_json_without_model_calls(self):
        planner = BehaviorPlanner("com.wdiodemoapp", ".MainActivity")
        planner.pending = [{"id": "BEH-complete", "objective": "Check a complete workflow", "category": "valid",
                            "setup": [], "steps": [{"action": "observe"}], "cleanup": [],
                            "verification": {"type": "postcondition", "texts": ["Success"]},
                            "source": {"kind": "app_profile"}}]
        driver = Mock(current_package="com.wdiodemoapp", current_activity=".MainActivity")
        driver.get_window_size.return_value = {"width": 100, "height": 200}
        evidence = [{"text": "Success", "bbox": [0,0,100,30], "is_title": True}]
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            root = Path(directory)
            for name, value in {"VISION_DIR": root, "SCREENSHOTS_DIR": root/"screenshots", "JSON_DIR": root/"json",
                                "DEBUG_DIR": root/"debug", "MEMORY_LOG_PATH": str(root/"vision_memory_log.json")}.items():
                stack.enter_context(patch.object(runner, name, value))
            stack.enter_context(patch.object(sys, "argv", ["explore_vision.py", "--max-steps", "2", "--app-package", "com.wdiodemoapp", "--app-activity", ".MainActivity", "--comparison", "unit-test"]))
            stack.enter_context(patch.object(runner, "BehaviorPlanner", return_value=planner))
            stack.enter_context(patch.object(runner, "build_driver", return_value=driver))
            stack.enter_context(patch.object(runner, "launch_start"))
            stack.enter_context(patch.object(runner, "wait_for_screen", return_value=(evidence, {"settled": True})))
            stack.enter_context(patch.object(runner, "capture_screenshot", return_value="unused.png"))
            stack.enter_context(patch.object(runner, "detect_ui_components", return_value=[]))
            stack.enter_context(patch.object(runner, "extract_text", return_value=[]))
            stack.enter_context(patch.object(runner, "merge", return_value={"elements": [], "screen": "Success"}))
            stack.enter_context(patch.object(runner, "verify_action", return_value={"changed": True}))
            model = stack.enter_context(patch.object(runner, "decide_next_action"))
            save = stack.enter_context(patch.object(runner.MobileRun, "save", autospec=True))
            self.assertEqual(runner.main(), 0)
            model.assert_not_called()
            row = save.call_args.args[0].run
            self.assertEqual(row["run_details"]["exploration"]["policy"], "functional_profile_then_model")
            self.assertEqual(row["run_details"]["llm"]["calls"], 0)
            self.assertEqual(len(row["test_cases"]), 1)
            self.assertEqual(json.loads((root/"run_summary.json").read_text())["llm_calls"], 0)


if __name__ == "__main__":
    unittest.main()
