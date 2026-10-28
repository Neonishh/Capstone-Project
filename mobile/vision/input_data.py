"""Named synthetic values: replay inputs without persisting arbitrary model text or secrets."""
import re
import os

FIXTURES = {
    "text": "QA sample 42", "unicode": "Caf\u00e9 test 42!", "long_text": "A" * 64,
    "empty": "", "email": "qa.mobile@example.com", "invalid_email": "not-an-email",
    "password": "Test1234!", "password_7": "Test123", "password_8": "Test1234",
    "mismatched_password": "Different123!", "number": "42", "search": "Wi-Fi",
}

def fixture_value(name):
    if name not in FIXTURES:
        raise ValueError("Unknown synthetic input fixture")
    return FIXTURES[name]

def field_fixture(element):
    identity = " ".join(str(element.get(k) or "") for k in
                        ("accessibility_id", "resource_id", "hint", "text")).casefold()
    if element.get("password") or re.search(r"password|passwd|confirm", identity):
        return "password"
    if "email" in identity or "e-mail" in identity:
        return "email"
    if "search" in identity or "query" in identity:
        return "search"
    if "number" in identity or "numeric" in str(element.get("input_type", "")).casefold():
        return "number"
    return "text"

def controlled_type(action, element):
    name = action.get("input_fixture") or field_fixture(element)
    return {**action, "action": "type", "input_fixture": name,
            "value": fixture_value(name), "clear": True, "hide_keyboard": True}

def read_step_value(step):
    # Named synthetic fixtures always take precedence over a logged/redacted value.
    if step.get("input_fixture"):
        return fixture_value(step["input_fixture"])
    if step.get("value_env"):
        name = step["value_env"]
        if not re.fullmatch(r"MOBILE_TEST_[A-Z0-9_]+", name):
            raise ValueError("Credential references must use a MOBILE_TEST_ environment variable")
        if not os.environ.get(name):
            raise ValueError("Missing configured test-account input: " + name)
        return os.environ[name]
    return step.get("value", "")
