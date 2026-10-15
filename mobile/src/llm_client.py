"""
llm_client.py
Mobile equivalent of web/src/llmClient.js

Responsibility:
  - call_llm(prompt, response_format="action") → dict | str
        response_format="action" -> normalised action dict (exploration steps)
        response_format="raw"    -> raw text response, untouched (test-case JSON arrays)
  - parse_action(response)        → dict   safe parse with fallback
  - execute_action(driver, action, elements) → performs tap/type/back/swipe on device

Environment variables:
  STUB_LLM=true         — run without a real LLM call. This is NOT a demo flag:
                          dry_run.py depends on it to exercise the whole pipeline
                          (loop, memory log, screenshots) against a fake driver
                          with zero external services. Keep it.
  LLM_PROVIDER=gemini    — which LLM backend to use (openai | gemini | ollama)
  OPENAI_API_KEY=...     — required when LLM_PROVIDER=openai
  OPENAI_MODEL=...       — optional, defaults to gpt-4o-mini
  GEMINI_API_KEY=...     — required when LLM_PROVIDER=gemini
  GEMINI_MODEL=...       — optional, defaults to gemini-flash-latest
  OLLAMA_HOST=...        — optional, defaults to http://localhost:11434
  OLLAMA_MODEL=...       — optional, defaults to llama3.1
"""

import json
import os
import time

# .env loading (if present) happens once in explore_mobile.py's entrypoint —
# by the time this module runs, os.environ already has the values.

STUB_MODE = os.environ.get("STUB_LLM", "false").lower() == "true"
LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "gemini").lower()


# ── Public API ────────────────────────────────────────────────────────────────

def call_llm(prompt: str, response_format: str = "action"):
    """
    Sends prompt to the configured LLM.

    Args:
        prompt: Exploration or test-case prompt string
        response_format:
            "action" -> returns a normalised action dict (used by explore_mobile.py)
            "raw"    -> returns the raw text response, untouched
                        (used by test_generator.py, which expects a JSON array)

    Returns:
        dict (response_format="action") or str (response_format="raw")

    Raises:
        RuntimeError: if LLM call fails and STUB_MODE is off, or provider unknown
    """
    if STUB_MODE:
        if response_format == "raw":
            print("[llm_client] STUB MODE — returning empty test-case array")
            return "[]"
        print("[llm_client] STUB MODE — returning dummy done action")
        return {
            "action": "done",
            "elementId": None,
            "resource_id": "",
            "value": "",
            "reason": "Stub mode active — LLM not wired yet",
        }

    if LLM_PROVIDER == "openai":
        raw_text = _call_openai_raw(prompt)
    elif LLM_PROVIDER == "gemini":
        raw_text = _call_gemini_raw(prompt)
    elif LLM_PROVIDER == "ollama":
        raw_text = _call_ollama_raw(prompt)
    else:
        raise RuntimeError(
            f"[llm_client] Unknown LLM_PROVIDER='{LLM_PROVIDER}'. "
            "Set STUB_LLM=true, or LLM_PROVIDER=openai / gemini / ollama."
        )

    if response_format == "raw":
        return raw_text

    return parse_action(raw_text)


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
      tap   — find element by resource_id, elementId, or on-screen position, tap it
      type  — find element, clear it, type value
      swipe — simple upward swipe (for scrolling)
      back  — presses the Android back button, so exploration can retreat from
              a dead-end screen and try a sibling path instead of stopping
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

    if action_type == "back":
        driver.back()
        time.sleep(0.5)
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

def _call_openai_raw(prompt: str) -> str:
    """Calls OpenAI chat completions API and returns the raw text content."""
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

    return response.choices[0].message.content


def _call_gemini_raw(prompt: str) -> str:
    """Calls Gemini generateContent API and returns the raw text content.

    Uses the current unified `google-genai` SDK (the old `google-generativeai`
    package and `gemini-2.0-flash` model are both retired): pip install google-genai

    Retries a few times on transient 503 UNAVAILABLE ("high demand") errors
    before giving up, since those are Google-side blips, not real failures -
    without this, a single overload spike burns an entire exploration step.
    """
    try:
        from google import genai
    except ImportError:
        raise RuntimeError(
            "[llm_client] google-genai package not installed. "
            "Run: pip install google-genai\n"
            "(Note: the old `google-generativeai` package is retired — "
            "uninstall it with `pip uninstall google-generativeai` if present.)"
        )

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError(
            "[llm_client] GEMINI_API_KEY environment variable not set."
        )

    # "gemini-flash-latest" is a Google-maintained alias that always points
    # at the current live flash model, so this survives future retirements
    # without needing a code change. Override with GEMINI_MODEL if you want
    # to pin a specific version instead.
    model_name = os.environ.get("GEMINI_MODEL", "gemini-flash-latest")
    client = genai.Client(api_key=api_key)

    max_retries = 3
    backoff_seconds = 5

    for attempt in range(1, max_retries + 1):
        try:
            response = client.models.generate_content(
                model=model_name,
                contents=prompt,
                config={"temperature": 0.2},
            )
            return response.text
        except Exception as e:
            is_transient = "503" in str(e) or "UNAVAILABLE" in str(e)
            if is_transient and attempt < max_retries:
                print(
                    f"[llm_client] Gemini overloaded (attempt {attempt}/{max_retries}), "
                    f"retrying in {backoff_seconds}s..."
                )
                time.sleep(backoff_seconds)
                backoff_seconds *= 2
                continue
            raise


def _call_ollama_raw(prompt: str) -> str:
    """
    Calls a locally-running Ollama server and returns the raw text content.

    Fully local, fully free, no rate limits and no internet dependency -
    good fit for an exploration loop that makes many frequent LLM calls,
    since it never hits a 503 "overloaded" response the way a free-tier
    hosted API can. The tradeoff is response quality/speed depends on your
    machine and the model size you pick.

    Setup (one-time):
      1. Install Ollama: https://ollama.com/download
      2. Pull a model, e.g.:  ollama pull llama3.1
      3. Ollama runs its own local server automatically after install
         (http://localhost:11434) - no separate "ollama serve" step needed
         on most installs, but run it manually if the request below fails.

    Environment variables:
      OLLAMA_HOST=http://localhost:11434  - optional, defaults shown
      OLLAMA_MODEL=llama3.1               - optional, defaults shown
    """
    import urllib.error
    import urllib.request

    host = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
    model_name = os.environ.get("OLLAMA_MODEL", "llama3.1")

    payload = json.dumps({
        "model": model_name,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0.2},
    }).encode("utf-8")

    request = urllib.request.Request(
        f"{host}/api/generate",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    # Local inference on modest hardware can be slow, and the test-case
    # generation prompt (built from the whole exploration log) is much
    # bigger than a single exploration-step prompt - a fixed short timeout
    # was cutting that call off before it finished. Configurable via env
    # in case your hardware needs even longer.
    timeout_seconds = int(os.environ.get("OLLAMA_TIMEOUT", 300))
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            body = json.loads(response.read().decode("utf-8"))
            return body.get("response", "")
    except TimeoutError:
        raise RuntimeError(
            f"[llm_client] Ollama call timed out after {timeout_seconds}s. "
            f"Local inference on this prompt took too long - try a smaller "
            f"model (e.g. OLLAMA_MODEL=llama3.2), or raise the limit with "
            f"OLLAMA_TIMEOUT=<seconds>."
        )
    except urllib.error.URLError as e:
        raise RuntimeError(
            f"[llm_client] Could not reach Ollama at {host}. "
            f"Make sure Ollama is installed and running, and that you've "
            f"pulled the model with: ollama pull {model_name}\n"
            f"Original error: {e}"
        )


def _normalise_action(d: dict) -> dict:
    """Ensures all expected keys exist with safe defaults."""
    return {
        "action":      d.get("action", "done"),
        "elementId":   d.get("elementId"),
        "resource_id": d.get("resource_id", ""),
        "value":       d.get("value", ""),
        "reason":      d.get("reason", ""),
    }


def _parse_bounds(bounds_str: str):
    """
    Parses an Android bounds string like '[100,200][900,300]' into a
    center point (x, y). Returns None if the string can't be parsed.
    """
    try:
        parts = bounds_str.replace("][", ",").strip("[]").split(",")
        x1, y1, x2, y2 = (int(p) for p in parts)
        return ((x1 + x2) // 2, (y1 + y2) // 2)
    except (ValueError, AttributeError):
        return None


class _CoordinateElement:
    """
    Best-effort stand-in for a WebElement, used when an element has no
    resource_id and no matching text — common for plain Buttons/Views in
    real apps that don't set android:id. Interacts via on-screen
    coordinates (derived from the view hierarchy's bounds) instead of a
    proper element handle.

    clear() is a no-op here — there's no reliable coordinate-based way to
    clear a field — so send_keys() may append rather than replace existing
    text. This only kicks in as a last resort after resource_id/text
    lookups have already failed.
    """
    def __init__(self, driver, x, y):
        self.driver = driver
        self.x = x
        self.y = y

    def click(self):
        self.driver.execute_script("mobile: clickGesture", {"x": self.x, "y": self.y})

    def clear(self):
        pass

    def send_keys(self, value):
        self.click()  # tap first to focus the field
        self.driver.execute_script("mobile: type", {"text": value})


def _find_element(driver, action: dict, elements: list):
    """
    Tries to locate an Appium WebElement, in order of reliability:
      1. resource_id, via AppiumBy.ID
      2. elementId lookup -> that element's own resource_id
      3. elementId lookup -> that element's visible text, via UiSelector
      4. elementId lookup -> that element's on-screen bounds (coordinate tap)

    Returns a WebElement, a _CoordinateElement, or None.
    """
    from appium.webdriver.common.appiumby import AppiumBy

    resource_id = (action.get("resource_id") or "").strip()
    if resource_id:
        try:
            return driver.find_element(AppiumBy.ID, resource_id)
        except Exception:
            pass

    element_id = action.get("elementId")
    match = None
    if element_id is not None:
        match = next((el for el in elements if el["elementId"] == element_id), None)

    if match and match.get("resource_id"):
        try:
            return driver.find_element(AppiumBy.ID, match["resource_id"])
        except Exception:
            pass

    if match and match.get("text"):
        try:
            return driver.find_element(
                AppiumBy.ANDROID_UIAUTOMATOR,
                f'new UiSelector().text("{match["text"]}")',
            )
        except Exception:
            pass

    if match and match.get("bounds"):
        center = _parse_bounds(match["bounds"])
        if center:
            return _CoordinateElement(driver, *center)

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