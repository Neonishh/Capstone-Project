"""
llm_reasoner.py
Module 5 — LLM Reasoning Engine

Responsibility:
  Takes the merged screen JSON + exploration history, builds a prompt,
  calls Ollama (or any provider), and returns the next action to execute.

  The LLM acts as an intelligent QA tester — it reads what's on screen
  (from YOLO+OCR merged output) and decides what to tap/type/swipe next.

  Output action format:
  {
    "action":  "tap" | "type" | "swipe" | "back" | "done",
    "target":  str,    # element text or type (e.g. "Login button")
    "bbox":    [x1, y1, x2, y2] | null,   # resolved from merged JSON
    "value":   str,    # only for type action
    "reason":  str     # one sentence explanation
  }
"""

import json
import os


LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "ollama").lower()


def decide_next_action(screen_data: dict, exploration_history: list) -> dict:
    """
    Sends the current screen state and history to the LLM and returns
    the next action to perform.

    Args:
        screen_data:         Merged screen dict from vision_merger.merge()
        exploration_history: List of past action dicts (grows each step)

    Returns:
        Action dict: { action, target, bbox, value, reason }
    """
    prompt = _build_prompt(screen_data, exploration_history)

    raw = _call_llm(prompt)
    action = _parse_response(raw)

    # Resolve bbox from screen elements if not provided by LLM
    if action.get("bbox") is None and action.get("target"):
        action["bbox"] = _resolve_bbox(action["target"], screen_data["elements"])

    print(
        f"[llm_reasoner] Action → {action['action']} | "
        f"target: {action.get('target', '')} | "
        f"reason: {action.get('reason', '')}"
    )
    return action


def _build_prompt(screen_data: dict, history: list) -> str:
    """Builds the LLM prompt from current screen + history."""

    # Compact element list for the prompt
    elements_summary = []
    for el in screen_data.get("elements", []):
        entry = {"type": el["type"]}
        if el.get("text"):
            entry["text"] = el["text"]
        entry["bbox"] = el.get("bbox")
        elements_summary.append(entry)

    # Last 5 history entries only
    recent_history = [
        {"step": h["step"], "action": h["action"], "target": h.get("target", "")}
        for h in history[-5:]
    ]

    # Targets already tried — tell LLM explicitly not to repeat them
    tried_targets = list({h.get("target", "") for h in history if h.get("target")})

    history_str = (
        json.dumps(recent_history, indent=2)
        if recent_history
        else "No actions yet — this is the first step."
    )
    tried_str = json.dumps(tried_targets) if tried_targets else "None"

    prompt = f"""You are an AI mobile app exploration agent using vision-based UI detection.

CURRENT SCREEN: "{screen_data.get('screen', 'unknown')}"

DETECTED UI ELEMENTS (from YOLO + OCR):
{json.dumps(elements_summary, indent=2)}

PREVIOUS ACTIONS:
{history_str}

ALREADY TRIED TARGETS (do NOT repeat these):
{tried_str}

RULES:
1. NEVER choose a target from the ALREADY TRIED TARGETS list above.
2. Prefer tapping buttons, icons, and interactive elements — avoid plain title text.
3. If no new interactive element is visible, return "swipe" to reveal more content.
4. For "type" actions, provide realistic test data.
5. Only return "done" if there is truly nothing left to explore.
6. Return ONLY valid JSON — no markdown, no explanation.

Respond with EXACTLY this JSON:
{{
  "action": "tap" | "type" | "swipe" | "back" | "done",
  "target": "<element text or type, e.g. 'Login button'>",
  "value":  "<text to type, only for type action, else empty string>",
  "reason": "<one sentence>"
}}"""

    return prompt


def _call_llm(prompt: str) -> str:
    """Routes to the configured LLM provider. Returns raw text response."""
    if LLM_PROVIDER == "ollama":
        return _call_ollama(prompt)
    if LLM_PROVIDER == "groq":
        return _call_groq(prompt)
    if LLM_PROVIDER == "gemini":
        return _call_gemini(prompt)
    if LLM_PROVIDER == "openai":
        return _call_openai(prompt)
    raise RuntimeError(
        f"[llm_reasoner] Unknown LLM_PROVIDER='{LLM_PROVIDER}'. "
        "Set LLM_PROVIDER=ollama (default) / groq / gemini / openai."
    )


def _call_ollama(prompt: str) -> str:
    import urllib.request, urllib.error

    host       = os.environ.get("OLLAMA_HOST",  "http://localhost:11434")
    model_name = os.environ.get("OLLAMA_MODEL", "llama3.1")
    timeout    = int(os.environ.get("OLLAMA_TIMEOUT", 120))

    payload = json.dumps({
        "model":  model_name,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0.2},
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{host}/api/generate",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.loads(resp.read().decode("utf-8"))
        return body.get("response", "")


def _call_groq(prompt: str) -> str:
    from groq import Groq
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        raise RuntimeError("[llm_reasoner] GROQ_API_KEY not set.")
    model = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")
    client = Groq(api_key=api_key)
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.2,
    )
    return resp.choices[0].message.content


def _call_gemini(prompt: str) -> str:
    import google.generativeai as genai
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("[llm_reasoner] GEMINI_API_KEY not set.")
    model_name = os.environ.get("GEMINI_MODEL", "gemini-1.5-flash")
    genai.configure(api_key=api_key)
    model = genai.GenerativeModel(model_name)
    return model.generate_content(prompt).text


def _call_openai(prompt: str) -> str:
    import openai
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("[llm_reasoner] OPENAI_API_KEY not set.")
    model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
    client = openai.OpenAI(api_key=api_key)
    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.2,
    )
    return resp.choices[0].message.content


def _parse_response(raw: str) -> dict:
    """Safely parses LLM response into an action dict."""
    # Try direct parse
    try:
        parsed = json.loads(raw)
        return _normalise(parsed)
    except (json.JSONDecodeError, TypeError):
        pass

    # Strip markdown fences
    cleaned = raw.replace("```json", "").replace("```", "").strip()
    try:
        parsed = json.loads(cleaned)
        return _normalise(parsed)
    except (json.JSONDecodeError, TypeError):
        pass

    # Bracket extraction
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start != -1 and end != -1:
        try:
            parsed = json.loads(cleaned[start:end + 1])
            return _normalise(parsed)
        except (json.JSONDecodeError, TypeError):
            pass

    print(f"[llm_reasoner] Failed to parse response — returning done fallback")
    return {"action": "done", "target": "", "bbox": None, "value": "", "reason": "parse_error"}


def _normalise(d: dict) -> dict:
    return {
        "action": d.get("action", "done"),
        "target": d.get("target", ""),
        "bbox":   d.get("bbox"),
        "value":  d.get("value", ""),
        "reason": d.get("reason", ""),
    }


def _resolve_bbox(target_text: str, elements: list):
    """
    Finds the bbox of the element whose text best matches the LLM's target.
    Returns [x1, y1, x2, y2] or None.
    """
    target_lower = target_text.lower()
    for el in elements:
        el_text = (el.get("text") or "").lower()
        el_type = (el.get("type") or "").lower()
        if el_text and el_text in target_lower:
            return el["bbox"]
        if el_type in target_lower:
            return el["bbox"]
    return None
