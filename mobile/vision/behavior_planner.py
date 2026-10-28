"""Budgeted workflows with live target resolution and explicit behavioral assertions."""
import copy
from vision.behavior_profiles import profile_cases
from vision.input_data import read_step_value
from vision.target_matcher import resolve_target

class BehaviorPlanner:
    def __init__(self, package, activity, enabled=True):
        self.package, self.activity = package, activity
        self.pending = profile_cases(package) if enabled else []
        self.active = None
        self.completed, self.review = [], []
        self.index = 0
        self.attempts = []
        self.seeks = 0

    def next_action(self, elements, screen_size):
        if not self.active:
            if not self.pending:
                return None
            self.active = self.pending.pop(0)
            self.sequence = [{"action": "relaunch"}] + self.active["setup"] + self.active["steps"]
            self.index, self.attempts, self.seeks = 0, [], 0
        step = self.sequence[self.index]
        action = {**copy.deepcopy(step), "_behavior_id": self.active["id"],
                  "reason": "behavior_profile:" + self.active["id"],
                  "app_package": self.package, "app_activity": self.activity}
        if step["action"] in {"tap", "type", "set_checked", "drag"}:
            element, _ = resolve_target(step.get("target", {}), elements, screen_size,
                                        step["action"] if step["action"] in {"type", "drag"} else "tap")
            if element is None:
                if self.seeks < 2:
                    self.seeks += 1
                    return {"action": "swipe", "direction": "up", "_behavior_seek": True,
                            "_behavior_id": self.active["id"], "reason": "behavior_seek_live_target"}
                self.review.append({"id": self.active["id"], "reason": "live_target_unavailable", "target": step.get("target")})
                self.active = None
                return self.next_action(elements, screen_size)
            action.update(element_index=elements.index(element), bbox=element["bbox"],
                          target=element.get("text") or element.get("accessibility_id") or element.get("resource_id", ""))
            if step["action"] == "drag":
                destination, _ = resolve_target(step.get("destination", {}), elements, screen_size, "observe")
                if destination is None:
                    self.review.append({"id": self.active["id"], "reason": "drag_destination_unavailable"})
                    self.active = None
                    return self.next_action(elements, screen_size)
                action["destination_bbox"] = destination["bbox"]
            if step["action"] == "type":
                action["value"] = read_step_value(step)
            if step["action"] == "set_checked":
                action["action"] = "tap" if element.get("checked") != step["checked"] else "observe"
        return action

    def record(self, action, execution, step_number, assertion=None):
        if not action.get("_behavior_id") or not self.active or action.get("_behavior_seek"):
            return
        self.attempts.append(step_number)
        if execution.get("status") != "executed":
            self.review.append({"id": self.active["id"], "reason": "action_failed", "step": step_number})
            self.active = None
            return
        self.seeks = 0
        self.index += 1
        if self.index == len(self.sequence):
            case = copy.deepcopy(self.active)
            case["source"].update(exploration_steps=self.attempts, exploration_assertion=assertion)
            self.completed.append(case)
            self.active = None

    def final_step(self, action):
        return bool(self.active and not action.get("_behavior_seek") and self.index == len(self.sequence) - 1)

    def summary(self):
        return {"completed_scenarios": len(self.completed), "remaining_scenarios": len(self.pending) + bool(self.active),
                "partial_scenario": self.active["id"] if self.active else None, "unavailable": self.review,
                "note": "Profile-driven functional scenarios are labeled separately from observed regressions."}
