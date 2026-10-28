"""Small Python adaptation of upstream WDIO reference behaviors, not AI-generated tests."""
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vision.explore_vision import build_driver
from vision.app_state import launch_start
from appium.webdriver.common.appiumby import AppiumBy
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

PACKAGE = "com.wdiodemoapp"
ACTIVITY = ".MainActivity"
SOURCES = [
    "https://github.com/webdriverio/appium-boilerplate/blob/main/tests/specs/app.forms.spec.ts",
    "https://github.com/webdriverio/appium-boilerplate/blob/main/tests/specs/app.login.spec.ts",
]


def main():
    root = Path(__file__).resolve().parents[1]
    output = root / "logs" / "benchmarks" / datetime.now(timezone.utc).strftime("wdio_reference_%Y%m%d_%H%M%SZ")
    output.mkdir(parents=True)
    driver = build_driver(PACKAGE, ACTIVITY)
    results = []

    def by_id(name):
        return WebDriverWait(driver, 15).until(
            lambda d: d.find_element(AppiumBy.ACCESSIBILITY_ID, name))

    def require(condition, message):
        if not condition:
            raise AssertionError(message)

    def input_echo():
        by_id("Forms").click()
        text = "Hello, this is a demo app"
        by_id("text-input").send_keys(text)
        actual = by_id("input-text-result").text
        require(text in actual, f"Expected input echo {text!r}, received {actual!r}")
        return {"expected": text, "actual": actual}

    def switch_roundtrip():
        by_id("Forms").click()
        switch = by_id("switch")
        initial = switch.get_attribute("checked")
        require(initial == "false", f"Expected initial switch off; received {initial}")
        switch.click()
        require(switch.get_attribute("checked") == "true", "Switch did not turn on")
        switch.click()
        require(switch.get_attribute("checked") == "false", "Switch did not turn off")
        return {"expected": [False, True, False], "actual": [False, True, False]}

    def dropdown():
        by_id("Forms").click()
        by_id("Dropdown").click()
        value = "Appium is awesome"
        WebDriverWait(driver, 15).until(EC.element_to_be_clickable((
            AppiumBy.ANDROID_UIAUTOMATOR, 'new UiSelector().text(' + json.dumps(value) + ')'))).click()
        actual = WebDriverWait(driver, 15).until(EC.presence_of_element_located((
            AppiumBy.XPATH, '//*[@content-desc="Dropdown"]//android.widget.EditText'))).text
        require(value in actual, f"Dropdown value mismatch: {actual!r}")
        return {"expected": value, "actual": actual}

    def login():
        by_id("Login").click()
        by_id("button-login-container").click()
        by_id("input-email").send_keys("test@webdriver.io")
        by_id("input-password").send_keys("Test1234!")
        if driver.is_keyboard_shown():
            driver.hide_keyboard()
        by_id("button-LOGIN").click()
        title = WebDriverWait(driver, 15).until(EC.visibility_of_element_located((
            AppiumBy.ANDROID_UIAUTOMATOR, 'new UiSelector().text("Success")')))
        message = driver.find_element(AppiumBy.ANDROID_UIAUTOMATOR,
                                      'new UiSelector().text("You are logged in!")')
        actual = title.text + " - " + message.text
        require(title.is_displayed() and message.is_displayed(), "Login success dialog is not visible")
        driver.find_element(AppiumBy.ANDROID_UIAUTOMATOR, 'new UiSelector().text("OK")').click()
        return {"expected": "Success", "actual": actual}

    try:
        for case_id, title, test in [
            ("REF001", "Input text is echoed", input_echo),
            ("REF002", "Switch turns on and off", switch_roundtrip),
            ("REF003", "Dropdown retains selected option", dropdown),
            ("REF004", "Login shows success alert", login),
        ]:
            start = time.perf_counter()
            result = {"id": case_id, "title": title, "status": "passed"}
            try:
                launch_start(driver, PACKAGE, ACTIVITY)
                by_id("Home")
                result["assertion"] = test()
            except Exception as exc:
                result.update(status="failed", error=str(exc))
            result["duration_ms"] = round((time.perf_counter() - start) * 1000)
            screenshot = output / f"{case_id}.png"
            driver.save_screenshot(str(screenshot))
            result["screenshot"] = str(screenshot)
            results.append(result)
            report = {"kind": "adapted_reference_smoke", "app_version": "v2.2.0",
                      "sources": SOURCES, "results": results,
                      "summary": {"total": len(results),
                                  "passed": sum(r["status"] == "passed" for r in results),
                                  "failed": sum(r["status"] == "failed" for r in results)}}
            (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(f"[reference] {case_id}: {result['status']}", flush=True)
    finally:
        driver.quit()
    print(f"[reference] Report: {output / 'report.json'}", flush=True)


if __name__ == "__main__":
    main()
