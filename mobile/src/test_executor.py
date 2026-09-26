"""
test_executor.py

Responsibility:
  Executes structured test cases directly via Appium (no generated script file
  needed — runs the action list in-process for speed and reliability).

  Captures per test case:
    - pass / fail status
    - execution time
    - exception message (if any)
    - screenshot path on failure

  Output: list of result dicts consumed by report_generator.py
"""

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path


# ── Public API ────────────────────────────────────────────────────────────────

def execute_test_cases(
    test_cases: list,
    driver,
    screenshots_dir: str,
) -> list:
    """
    Runs each test case against the live Appium driver and returns results.

    Args:
        test_cases:      List of structured test case dicts
        driver:          Active Appium WebDriver instance
        screenshots_dir: Directory to save failure screenshots

    Returns:
        List of result dicts (one per test case)
    """
    Path(screenshots_dir).mkdir(parents=True, exist_ok=True)
    results = []

    for tc in test_cases:
        tc_id  = tc.get("test_case_id") or tc.get("id", "TC000")
        title  = tc.get("title", tc.get("objective", tc_id))
        steps  = tc.get("steps", [])

        print(f"\n[test_executor] Running {tc_id}: {title}")
        start = time.time()

        status    = "PASS"
        error_msg = None
        screenshot_path = None

        try:
            for i, step in enumerate(steps, 1):
                action = (step.get("action") or "").strip()
                # support both "target" and "resource_id" field names —
                # LLMs sometimes use resource_id from the exploration schema
                target = (step.get("target") or step.get("resource_id") or "").strip()
                value  = (step.get("value")  or "").strip()

                print(f"  Step {i}: {action} → {target}" + (f" = '{value}'" if value else ""))
                _execute_step(driver, action, target, value)
                time.sleep(0.5)

        except Exception as e:
            status    = "FAIL"
            error_msg = str(e)
            print(f"  [FAIL] {e}")

            # Screenshot on failure
            ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
            screenshot_path = str(Path(screenshots_dir) / f"FAIL_{tc_id}_{ts}.png")
            try:
                driver.save_screenshot(screenshot_path)
                print(f"  Screenshot saved → {screenshot_path}")
            except Exception as ss_err:
                print(f"  Screenshot failed: {ss_err}")
                screenshot_path = None

        elapsed = round(time.time() - start, 2)
        result = {
            "test_case":      tc_id,
            "title":          title,
            "status":         status,
            "execution_time": f"{elapsed}s",
            "timestamp":      datetime.now(timezone.utc).isoformat(),
        }
        if error_msg:
            result["error"] = error_msg
        if screenshot_path:
            result["screenshot"] = screenshot_path

        results.append(result)
        print(f"  [{status}] {tc_id} — {elapsed}s")

    return results


# ── Step executor ─────────────────────────────────────────────────────────────

def _execute_step(driver, action: str, target: str, value: str) -> None:
    """
    Dispatches a single test step to the appropriate Appium call.

    Supported actions:
      tap, enterText, longPress, swipe, back
    """
    action_lower = action.lower()

    if action_lower == "back":
        driver.back()
        time.sleep(0.5)
        return

    if action_lower == "swipe":
        _do_swipe(driver)
        return

    # "verify" is not a real Appium action — skip it gracefully
    if action_lower == "verify":
        print(f"    [skip] 'verify' is not executable — skipping step")
        return

    if action_lower in ("tap", "entertext", "longpress"):
        element = _find_element(driver, target)
        if element is None:
            raise RuntimeError(f"Element not found for target: '{target}'")

        if action_lower == "tap":
            element.click()

        elif action_lower == "entertext":
            element.clear()
            element.send_keys(value)

        elif action_lower == "longpress":
            from selenium.webdriver.common.action_chains import ActionChains
            ActionChains(driver).click_and_hold(element).pause(1.5).release().perform()

        return

    raise RuntimeError(f"Unsupported action: '{action}'")


def _find_element(driver, target: str):
    """
    Locates an element by resource_id or accessibility_id.
    Returns WebElement or None.
    """
    from appium.webdriver.common.appiumby import AppiumBy

    if not target:
        return None

    # resource-id contains '/' or ':id/'
    if "/" in target or ":id/" in target:
        try:
            return driver.find_element(AppiumBy.ID, target)
        except Exception:
            pass
    else:
        # Try accessibility id first
        try:
            return driver.find_element(AppiumBy.ACCESSIBILITY_ID, target)
        except Exception:
            pass

    # Fallback: visible text
    try:
        from appium.webdriver.common.appiumby import AppiumBy
        return driver.find_element(
            AppiumBy.ANDROID_UIAUTOMATOR,
            f'new UiSelector().text("{target}")',
        )
    except Exception:
        pass

    return None


def _do_swipe(driver) -> None:
    size = driver.get_window_size()
    w, h = size["width"], size["height"]
    driver.swipe(
        start_x=w // 2, start_y=int(h * 0.75),
        end_x=w // 2,   end_y=int(h * 0.25),
        duration=500,
    )
    time.sleep(0.5)
