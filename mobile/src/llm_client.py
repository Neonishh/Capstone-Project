"""
llm_client.py
Mobile equivalent of web/src/llmClient.js

Responsibility:
  - call_llm(prompt)              → dict   parsed JSON response from LLM
  - parse_action(response)        → dict   safe parse with fallback
  - execute_action(driver, action, elements) → performs tap/type on device

Environment variables:
  STUB_LLM=true        — run without real LLM (returns done action)
  LLM_PROVIDER=groq    — which LLM backend to use (groq | openai)
  GROQ_API_KEY=...     — required when LLM_PROVIDER=groq
  GROQ_MODEL=...       — optional, defaults to llama3-8b-8192
  OPENAI_API_KEY=...   — required when LLM_PROVIDER=openai
  OPENAI_MODEL=...     — optional, defaults to gpt-4o-mini
"""

import json
import os
import time

STUB_MODE = os.environ.get("STUB_LLM", "false").lower() == "true"
LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "groq").lower()


# ── Public API ────────────────────────────────────────────────────────────────

def call_llm(prompt: str) -> dict:
    """
    Sends prompt to the configured LLM and returns a parsed action dict.
    Mirrors callLLM() in llmClient.js.

    Args:
        prompt: Exploration or test-case prompt string

    Returns:
        Parsed dict from LLM response

    Raises:
        RuntimeError: if LLM call fails and STUB_MODE is off
    """
    if STUB_MODE:
        print("[llm_client] STUB MODE — returning dummy done action")
        return {
            "action": "done",
            "elementId": None,
            "resource_id": "",
            "value": "",
            "reason": "Stub mode active — LLM not wired yet",
        }

    if LLM_PROVIDER == "groq":
        return _call_groq(prompt)

    if LLM_PROVIDER == "openai":
        return _call_openai(prompt)

    raise RuntimeError(
        f"[llm_client] Unknown LLM_PROVIDER='{LLM_PROVIDER}'. "
        "Set STUB_LLM=true or LLM_PROVIDER=groq."
    )


def parse_action(response) -> dict:
    """
    Safely parses raw LLM response (string or dict) into an action dict.
    Returns a safe fallback on parse failure.
    Mirrors parseAction() in llmClient.js.

    Args:
        response: Raw LLM response (dict or JSON string)

    Returns:
        Action dict with keys: action, elementId, resource_id, value, reason
    """
    if STUB_MODE:
        return {
            "action": "done",
            "elementId": None,
            "resource_id": "",
            "value": "",
            "reason": "stub",
        }

    if isinstance(response, dict):
        return _normalise_action(response)

    # Try direct parse
    try:
        parsed = json.loads(response)
        return _normalise_action(parsed)
    except (json.JSONDecodeError, TypeError):
        pass

    # Strip markdown fences and retry
    cleaned = str(response)
    for fence in ["```json", "```"]:
        cleaned = cleaned.replace(fence, "")
    cleaned = cleaned.strip()

    try:
        parsed = json.loads(cleaned)
        return _normalise_action(parsed)
    except (json.JSONDecodeError, TypeError) as e:
        print(f"[llm_client] parse_action failed: {e} — returning done fallback")
        return {
            "action": "done",
            "elementId": None,
            "resource_id": "",
            "value": "",
            "reason": "parse_error",
        }


def execute_action(driver, action: dict, elements: list) -> None:
    """
    Executes a parsed action on the Android device via Appium.
    Mirrors executeAction() in llmClient.js.

    Supported actions:
      tap   — find element by resource_id or elementId, tap it
      type  — find element, clear it, type value
      swipe — simple upward swipe (for scrolling)
      done  — no-op

    Args:
        driver:   Appium WebDriver instance
        action:   Parsed action dict from parse_action()
        elements: Current preprocessed element list (for elementId lookup)

    Raises:
        RuntimeError: if element cannot be found
    """
    action_type = action.get("action", "done")

    if action_type == "done":
        return

    if action_type == "swipe":
        _do_swipe(driver)
        return

    # Resolve element — prefer resource_id, fall back to elementId lookup
    element = _find_element(driver, action, elements)
    if element is None:
        raise RuntimeError(
            f"[llm_client] Could not find element for action: {action}"
        )

    if action_type == "tap":
        element.click()

    elif action_type == "type":
        value = action.get("value", "")
        element.clear()
        element.send_keys(value)

    else:
        print(f"[llm_client] Unknown action type '{action_type}' — skipping")


# ── Private helpers ───────────────────────────────────────────────────────────

def _call_groq(prompt: str) -> dict:
    """Calls Groq API and returns parsed JSON dict."""
    try:
        from groq import Groq
    except ImportError:
        raise RuntimeError(
            "[llm_client] groq package not installed. Run: pip install groq"
        )

    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        raise RuntimeError(
            "[llm_client] GROQ_API_KEY environment variable not set."
        )

    model = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")
    client = Groq(api_key=api_key)

    response = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.2,
    )

    raw = response.choices[0].message.content
    return parse_action(raw)


def _call_openai(prompt: str) -> dict:
    """Calls OpenAI chat completions API and returns parsed JSON dict."""
    try:
        import openai  # lazy import — only needed when LLM_PROVIDER=openai
    except ImportError:
        raise RuntimeError(
            "[llm_client] openai package not installed. Run: pip install openai"
        )

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError(
            "[llm_client] OPENAI_API_KEY environment variable not set."
        )

    model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
    client = openai.OpenAI(api_key=api_key)

    response = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.2,
    )

    raw = response.choices[0].message.content
    return parse_action(raw)


def _normalise_action(d: dict) -> dict:
    """Ensures all expected keys exist with safe defaults."""
    return {
        "action":      d.get("action", "done"),
        "elementId":   d.get("elementId"),
        "resource_id": d.get("resource_id", ""),
        "value":       d.get("value", ""),
        "reason":      d.get("reason", ""),
    }


def _find_element(driver, action: dict, elements: list):
    """
    Tries to locate an Appium WebElement using resource_id first,
    then falls back to elementId-based bounds tap.

    Returns WebElement or None.
    """
    from appium.webdriver.common.appiumby import AppiumBy

    resource_id = action.get("resource_id", "").strip()
    if resource_id:
        try:
            return driver.find_element(AppiumBy.ID, resource_id)
        except Exception:
            pass

    # Fallback: look up element in our list by elementId and use bounds
    element_id = action.get("elementId")
    if element_id is not None:
        match = next((el for el in elements if el["elementId"] == element_id), None)
        if match and match.get("resource_id"):
            try:
                return driver.find_element(AppiumBy.ID, match["resource_id"])
            except Exception:
                pass
        if match and match.get("text"):
            try:
                return driver.find_element(AppiumBy.ANDROID_UIAUTOMATOR,
                    f'new UiSelector().text("{match["text"]}")')
            except Exception:
                pass

    return None


def _do_swipe(driver) -> None:
    """Performs a simple upward swipe to scroll down."""
    size = driver.get_window_size()
    w, h = size["width"], size["height"]
    driver.swipe(
        start_x=w // 2, start_y=int(h * 0.75),
        end_x=w // 2,   end_y=int(h * 0.25),
        duration=500,
    )
    time.sleep(0.5)
