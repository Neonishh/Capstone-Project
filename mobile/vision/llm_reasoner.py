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
    elements = screen_data.get("elements", [])
    if not elements:
        return {
            "action": "done",
            "element_index": None,
            "target": "",
            "bbox": None,
            "value": "",
            "reason": "no_detected_elements",
        }
    if not any(el.get("clickable") or el.get("checkable") or el.get("editable") for el in elements):
        return {
            "action": "swipe",
            "element_index": None,
            "target": "",
            "bbox": None,
            "value": "",
            "reason": "no_accessibility_interactive_controls",
        }

    prompt = _build_prompt(screen_data, exploration_history)

    raw = _call_llm(prompt)
    action = _parse_response(raw)

    if action.get("action") == "type" and not str(action.get("value") or "").strip():
        return {
            "action": "back",
            "element_index": None,
            "target": "",
            "bbox": None,
            "value": "",
            "reason": "missing_type_value",
        }

    # Prefer an explicit element index because text can be ambiguous.
    resolved_bbox = _resolve_action_bbox(action, screen_data.get("elements", []))
    if resolved_bbox is not None:
        action["bbox"] = resolved_bbox
        if action.get("element_index") is None:
            action["element_index"] = _find_resolved_element_index(action, screen_data.get("elements", []))
    elif action.get("action") in ("tap", "type"):
        # Do not trust a free-form bbox from the model when it did not map to
        # an element present on the current screen.
        action["bbox"] = None

    # Never execute an invented tap/type target. Continue exploration with a
    # swipe when the model cannot map its choice to a real interactive element.
    if action.get("action") in ("tap", "type") and action.get("bbox") is None:
        action.update({
            "action": "swipe",
            "target": "",
            "reason": "target_not_detected",
        })

    print(
        f"[llm_reasoner] Action → {action['action']} | "
        f"target: {action.get('target', '')} | "
        f"reason: {action.get('reason', '')}"
    )
    return action


def _build_prompt(screen_data: dict, history: list) -> str:
    """Builds the LLM prompt from current screen + history."""

    # Only elements with explicit interactivity are valid tap targets.
    elements_summary = []
    for index, el in enumerate(screen_data.get("elements", [])):
        entry = {
            "element_index": index,
            "type": el.get("type", "unknown"),
            "interactive": bool(el.get("clickable") or el.get("checkable")),
            "editable": bool(el.get("editable")),
        }
        if el.get("text"):
            entry["text"] = el["text"]
        entry["bbox"] = el.get("bbox")
        if el.get("checkable"):
            entry["checked"] = bool(el.get("checked"))
        elements_summary.append(entry)
    actionable_summary = [
        el for el in elements_summary if el["interactive"] or el["editable"]
    ]

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

INTERACTIVE CONTROLS (the only valid tap targets):
{json.dumps(actionable_summary, indent=2)}

PREVIOUS ACTIONS:
{history_str}

ALREADY TRIED TARGETS (do NOT repeat these):
{tried_str}

RULES:
1. Tap only an element whose interactive field is true. Use its element_index.
2. Never tap plain text/title elements or guess a target absent from the list.
3. For "type", choose only an element whose editable field is true.
4. If no untried interactive control remains, return "swipe" to explore more content.
5. Only return "done" if there is truly nothing left to explore.
6. Return ONLY valid JSON — no markdown, no explanation.

Respond with EXACTLY this JSON:
{{
  "action": "tap" | "type" | "swipe" | "back" | "done",
    "element_index": <number from the list above, or null for swipe/back/done>,
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
    element_index = d.get("element_index")
    if isinstance(element_index, str) and element_index.strip().isdigit():
        element_index = int(element_index.strip())
    return {
        "action": d.get("action", "done"),
        "element_index": element_index,
        "target": d.get("target", ""),
        "bbox":   d.get("bbox"),
        "value":  d.get("value", ""),
        "reason": d.get("reason", ""),
    }


def _resolve_action_bbox(action: dict, elements: list):
    """Resolve an action bbox using its explicit index or target text."""
    action_type = action.get("action")

    def eligible(element):
        if action_type == "tap":
            return bool(element.get("clickable") or element.get("checkable"))
        if action_type == "type":
            return bool(element.get("editable"))
        return True

    element_index = action.get("element_index")
    if isinstance(element_index, int) and 0 <= element_index < len(elements):
        element = elements[element_index]
        return element.get("bbox") if eligible(element) else None

    if action.get("target"):
        return _resolve_bbox(action["target"], [el for el in elements if eligible(el)])

    return None


def _find_resolved_element_index(action: dict, elements: list):
    """Return the index of the element used by target-text resolution."""
    action_type = action.get("action")

    def eligible(element):
        if action_type == "tap":
            return bool(element.get("clickable") or element.get("checkable"))
        if action_type == "type":
            return bool(element.get("editable"))
        return True

    eligible_elements = [
        (index, element) for index, element in enumerate(elements)
        if eligible(element)
    ]
    target = action.get("target")
    if not target:
        return None
    bbox = _resolve_bbox(target, [element for _, element in eligible_elements])
    for index, element in eligible_elements:
        if element.get("bbox") == bbox:
            return index
    return None


def _normalise_text(value: str) -> str:
    """Normalize OCR and LLM text before comparing it."""
    return " ".join((value or "").split()).casefold()


def _resolve_bbox(target_text: str, elements: list):
    """
    Resolve the bbox for the LLM-selected target.

    Exact matches are preferred, followed by targets contained in longer OCR
    labels. Returns [x1, y1, x2, y2] or None.
    """
    target = _normalise_text(target_text)
    if not target:
        return None

    text_elements = [
        (el, _normalise_text(el.get("text")))
        for el in elements
    ]

    # Exact text match, but refuse ambiguous labels such as repeated "Off".
    exact_matches = [el for el, text in text_elements if text == target]
    unique_exact_bboxes = {tuple(el.get("bbox") or []) for el in exact_matches}
    if len(unique_exact_bboxes) == 1:
        return exact_matches[0].get("bbox")
    if len(unique_exact_bboxes) > 1:
        return None

    # Target appears inside a longer OCR label.
    contained_matches = [el for el, text in text_elements if target in text]
    unique_contained_bboxes = {tuple(el.get("bbox") or []) for el in contained_matches}
    if len(unique_contained_bboxes) == 1:
        return contained_matches[0].get("bbox")
    if len(unique_contained_bboxes) > 1:
        return None

    # Backward-compatible fallback for targets such as "button" or "icon".
    for el in elements:
        el_type = _normalise_text(el.get("type"))
        if el_type and el_type in target:
            return el.get("bbox")

    return None
