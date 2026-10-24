"""Explicit demo-app behavior contracts, separate from observation-derived regressions.

Sources: native-demo-app v2.2.0; appium-boilerplate tests/specs/app.forms.spec.ts
and app.login.spec.ts. These are profile-driven scenarios, not LLM-generated cases.
Only attempted workflows are emitted; an unavailable feature is recorded as such.
"""
import copy

def target(name):
    return {"accessibility_id": name}

def tap(name, **extra):
    return {"action": "tap", "target": target(name), "expect_change": False, **extra}

def fill(name, fixture):
    return {"action": "type", "target": target(name), "input_fixture": fixture,
            "clear": True, "hide_keyboard": True, "expect_change": False}

def text(*texts):
    return {"type": "postcondition", "texts": list(texts)}

def value(name, fixture):
    return {"type": "control_value", "target": target(name), "input_fixture": fixture}

def state(checked):
    return {"type": "control_state", "target": target("switch"), "checked": checked}

def case(name, objective, category, setup, steps, oracle):
    return {"id": "BEH-WDIO-" + name, "objective": objective, "category": category,
            "setup": setup, "steps": steps, "cleanup": [{"action": "relaunch"}],
            "verification": oracle, "expected_result": oracle,
            "source": {"kind": "app_profile", "profile": "wdio-demo-v2.2.0",
                       "references": ["https://github.com/webdriverio/native-demo-app/tree/v2.2.0",
                                      "https://github.com/webdriverio/appium-boilerplate/tree/main/tests/specs"]}}

def wdio_cases():
    forms = [tap("Forms")]
    login = [tap("Login"), tap("button-login-container")]
    signup = [tap("Login"), tap("button-sign-up-container")]
    submit_login = lambda email, password: [fill("input-email", email), fill("input-password", password), tap("button-LOGIN")]
    submit_signup = lambda password, confirm: [fill("input-email", "email"), fill("input-password", password),
                                               fill("input-repeat-password", confirm), tap("button-SIGN UP")]
    cases = [
        case("input-echo", "Typed text is echoed exactly in Forms", "valid", forms,
             [fill("text-input", "text")], value("input-text-result", "text")),
        case("dropdown-select", "Dropdown displays the selected option", "selection", forms,
             [{"action": "tap", "target": {"accessibility_id": "Dropdown", "editable": True}, "expect_change": False},
              {"action": "tap", "target": {"text": "Appium is awesome"}, "expect_change": False}],
             {"type": "control_value", "target": {"accessibility_id": "Dropdown", "editable": True}, "value": "Appium is awesome"}),
        case("switch-on", "Switch can be explicitly enabled", "state", forms,
             [{"action": "set_checked", "target": target("switch"), "checked": True, "expect_change": False}], state(True)),
        case("login-valid", "Valid demo credentials show the login success alert", "valid", login,
             submit_login("email", "password"), text("Success", "You are logged in!")),
        case("alert-cancel", "Cancelling the Forms alert returns to the form", "cancellation", forms,
             [tap("button-Active"), {"action": "tap", "target": {"text": "CANCEL"}, "expect_change": False}],
             {"type": "all", "conditions": [{"type": "control_present", "target": target("text-input"), "editable": True},
                                                {"type": "text_absent", "texts": ["This button is active"]}]}),
        case("signup-valid", "Matching valid sign-up fields show the signed-up alert", "valid", signup,
             submit_signup("password", "password"), text("Signed Up!", "You successfully signed up!")),
        case("input-unicode", "Forms preserves Unicode and punctuation", "boundary", forms,
             [fill("text-input", "unicode")], value("input-text-result", "unicode")),
        case("login-invalid-email", "Malformed email is rejected on login", "invalid", login,
             submit_login("invalid_email", "password"), text("Please enter a valid email address")),
        case("password-below-minimum", "A seven-character password is rejected", "boundary", login,
             submit_login("email", "password_7"), text("Please enter at least 8 characters")),
        case("password-at-minimum", "An eight-character demo password is accepted", "boundary", login,
             submit_login("email", "password_8"), text("Success", "You are logged in!")),
        case("signup-password-mismatch", "Sign-up rejects mismatched password confirmation", "invalid", signup,
             submit_signup("password", "mismatched_password"), text("Please enter the same password")),
        case("login-empty", "Empty login fields show required-input validation", "invalid", login,
             [tap("button-LOGIN")], text("Please enter a valid email address", "Please enter at least 8 characters")),
        case("switch-off", "Switch can be enabled and then disabled", "state", forms,
             [{"action": "set_checked", "target": target("switch"), "checked": True, "expect_change": False},
              {"action": "set_checked", "target": target("switch"), "checked": False, "expect_change": False}], state(False)),
        case("input-clear", "Clearing an input clears its echoed value", "boundary", forms,
             [fill("text-input", "text"), fill("text-input", "empty")], value("input-text-result", "empty")),
        case("input-replace", "Replacing text does not append to the previous value", "valid", forms,
             [fill("text-input", "text"), fill("text-input", "unicode")], value("input-text-result", "unicode")),
        case("input-tab-persistence", "Forms input survives navigation away and back", "persistence", forms,
             [fill("text-input", "text"), tap("Home"), tap("Forms")], value("input-text-result", "text")),
        case("login-dismiss", "Dismissing login success returns to the Login form", "cancellation", login,
             submit_login("email", "password") + [{"action": "tap", "target": {"text": "OK"}, "expect_change": False}],
             {"type": "all", "conditions": [{"type": "control_present", "target": target("input-email"), "editable": True},
                                                {"type": "text_absent", "texts": ["You are logged in!"]}]})
    ]
    gestures = [
        case("carousel-next", "Horizontal swipe reveals the next carousel card", "gesture", [tap("Swipe")],
             [{"action": "swipe", "direction": "left", "expect_change": True}],
             {"type": "text_in_view", "text": "Great community", "min_width_fraction": 0.4}),
        case("vertical-scroll", "Vertical swiping reveals the hidden content", "gesture", [tap("Swipe")],
             [{"action": "swipe", "direction": "up", "swipe_region": [0.1,0.0,0.8,0.55],
               "duration_ms": 180, "expect_change": False}] +
             [{"action": "swipe", "direction": "up", "duration_ms": 180, "expect_change": False}] * 2,
             text("You found me!!!")),
        case("drag-puzzle", "Dragging all puzzle pieces to their matching slots completes the puzzle", "gesture", [tap("Drag")],
             [{"action": "drag", "target": target("drag-" + position), "destination": target("drop-" + position), "expect_change": False}
              for position in ("l1", "c1", "r1", "l2", "c2", "r2", "l3", "c3", "r3")], text("Congratulations"))
    ]
    # Show breadth within a short budget, then spend additional steps on input variants.
    cases.insert(3, gestures[0])
    cases.extend(gestures[1:])
    return copy.deepcopy(cases)

def profile_cases(package):
    return wdio_cases() if package == "com.wdiodemoapp" else []
