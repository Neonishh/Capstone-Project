"""
mobile_preprocess.py
Mobile equivalent of web/src/preprocess.js

Responsibility:
  1. preprocess_elements(raw_elements) — filter, deduplicate, prioritise,
     cap at 50, re-assign sequential elementId.
  2. build_exploration_prompt(elements, memory_log) — LLM prompt for next action.
  3. build_test_case_prompt(memory_log) — LLM prompt to generate test cases.
"""

import json

MAX_ELEMENTS = 50  # token budget cap — mirrors web side

# Priority order for element types (lower = higher priority)
_CLASS_PRIORITY = {
    "android.widget.Button": 0,
    "android.widget.ImageButton": 0,
    "android.widget.EditText": 1,
    "android.widget.CheckBox": 2,
    "android.widget.RadioButton": 2,
    "android.widget.Switch": 2,
    "android.widget.Spinner": 3,
    "android.widget.TextView": 4,
    "android.view.View": 5,
    "android.widget.LinearLayout": 6,
    "android.widget.RelativeLayout": 6,
}


def preprocess_elements(raw_elements: list) -> list:
    """
    Filters and cleans raw element list from view_hierarchy_parser.
    Mirrors preprocessDOM() in preprocess.js.

    Steps:
      1. Remove elements with no identifying info
      2. Deduplicate by resource_id (keep first occurrence)
      3. Prioritise by class type
      4. Cap at MAX_ELEMENTS
      5. Re-assign sequential elementId

    Args:
        raw_elements: Output from parse_elements()

    Returns:
        Cleaned, capped element list
    """
    if not raw_elements:
        return []

    # Step 1: Remove elements with no useful identifying info
    filtered = [
        el for el in raw_elements
        if _has_identifying_info(el)
    ]

    # Step 2: Deduplicate by resource_id (skip elements with no resource_id from dedup)
    seen_ids = set()
    deduped = []
    for el in filtered:
        rid = el.get("resource_id")
        if rid:
            if rid in seen_ids:
                continue
            seen_ids.add(rid)
        deduped.append(el)

    # Step 3: Sort by class priority
    deduped.sort(key=lambda el: _CLASS_PRIORITY.get(el.get("class_name", ""), 99))

    # Step 4: Cap
    capped = deduped[:MAX_ELEMENTS]

    # Step 5: Re-assign sequential elementId
    for i, el in enumerate(capped):
        el["elementId"] = i

    return capped


def _has_identifying_info(el: dict) -> bool:
    """Returns True if element has at least one useful identifier."""
    return bool(
        (el.get("text") or "").strip()
        or (el.get("resource_id") or "").strip()
        or (el.get("content_desc") or "").strip()
    )


def get_tried_targets(memory_log: list, current_url: str) -> set:
    """
    Returns the set of 'target' values (resource_id or class name) already
    attempted on the given screen, based on the exploration log so far.

    Shared by build_exploration_prompt() (to tell the LLM what not to
    repeat) and explore_mobile.py's post-decision enforcement check (to
    catch it when it repeats something anyway - smaller/local models don't
    reliably follow the prompt's "don't repeat this" instruction, so the
    pipeline can't only rely on asking nicely).
    """
    if not current_url:
        return set()
    return {
        s["target"] for s in memory_log
        if s.get("from_url") == current_url and s.get("target")
    }


def build_exploration_prompt(elements: list, memory_log: list, current_url: str = None) -> str:
    """
    Builds the LLM prompt for deciding the next exploration action.
    Mobile equivalent of buildExplorationPrompt() in preprocess.js.

    Expected LLM response format:
    {
      "action": "tap" | "type" | "swipe" | "back" | "done",
      "elementId": <int or null>,
      "resource_id": "<resource-id string>",
      "value": "<text to type, only for type action>",
      "reason": "<one sentence>"
    }

    Args:
        elements:    Preprocessed element list
        memory_log:  Current exploration log (may be empty on step 0)
        current_url: "package/activity" of the screen being decided on right
                     now, used to tell the LLM what it's already tried HERE
                     so it explores sideways (back + try a sibling) instead
                     of repeating itself or giving up with "done" too early.

    Returns:
        Prompt string to pass to call_llm()
    """
    # Last 5 steps only — avoid token overflow
    recent_steps = [
        {
            "step": s["step"],
            "action": s["action"],
            "target": s["target"],
            "from_url": s["from_url"],
            "to_url": s["to_url"],
        }
        for s in memory_log[-5:]
    ]

    # What's already been attempted on THIS specific screen, so the LLM
    # doesn't retap the same element or think it's found something new when
    # it hasn't. Without this, dead-ends just repeat until loop-detection
    # kicks in and the whole run stops early.
    tried_on_this_screen = sorted(get_tried_targets(memory_log, current_url))

    # Compact element list — only what the LLM needs
    compact_elements = [
        {
            "elementId": el["elementId"],
            "tag": el["tag"],
            "text": el.get("text", ""),
            "resource_id": el.get("resource_id", ""),
            "content_desc": el.get("content_desc", ""),
            "clickable": el.get("clickable", False),
        }
        for el in elements
    ]

    history_str = (
        json.dumps(recent_steps, indent=2)
        if recent_steps
        else "No steps yet — this is the first action."
    )
    tried_str = (
        json.dumps(tried_on_this_screen)
        if tried_on_this_screen
        else "None yet — this screen is unexplored."
    )

    prompt = f"""You are an AI mobile app exploration agent. Your job is to decide the NEXT single action to systematically explore an Android app and discover functional flows (login, navigation, form submission, etc.).

CURRENT SCREEN ELEMENTS (filtered, max 50):
{json.dumps(compact_elements, indent=2)}

ELEMENTS ALREADY TRIED ON THIS SCREEN:
{tried_str}

RECENT EXPLORATION HISTORY (last 5 steps):
{history_str}

RULES:
1. Prefer unexplored elements — never repeat something already listed under "ELEMENTS ALREADY TRIED ON THIS SCREEN".
2. Prefer meaningful actions: login forms, nav buttons, submit buttons.
3. For "type" actions, provide realistic test data (e.g. email: "test@example.com").
4. If every element on this screen has already been tried, or this screen is a dead end, return action "back" to return to the previous screen and try a different, unexplored path from there — this keeps exploration going wider across the app instead of stopping.
5. Only return "done" if there is truly nothing left to explore — e.g. you are back at the app's starting screen with no untried elements remaining, or you've thoroughly covered the app's main flows.
6. Do NOT return explanations — return ONLY valid JSON.

Respond with EXACTLY this JSON structure (no markdown, no extra text):
{{
  "action": "tap" | "type" | "swipe" | "back" | "done",
  "elementId": <number from list above, or null for back/done>,
  "resource_id": "<resource-id string or empty>",
  "value": "<text to type, only for type action>",
  "reason": "<one sentence explanation>"
}}"""

    return prompt


def build_test_case_prompt(memory_log: list) -> str:
    """
    Builds the LLM prompt to generate structured test cases from the memory log.
    Mobile equivalent of buildTestCasePrompt() in preprocess.js.

    Args:
        memory_log: Full completed exploration log

    Returns:
        Prompt string to pass to call_llm()
    """
    trimmed_log = [
        {
            "step": s["step"],
            "action": s["action"],
            "target": s["target"],
            "resource_id": (s.get("target_element_details") or {}).get("resource_id", ""),
            "from_url": s["from_url"],
            "to_url": s["to_url"],
            "value": s.get("value", ""),
        }
        for s in memory_log
    ]

    prompt = f"""You are a QA engineer. Based on the following Android app UI exploration log, generate structured functional test cases.

EXPLORATION LOG:
{json.dumps(trimmed_log, indent=2)}

Generate 3 to 5 functional test cases that cover the key user flows discovered above (e.g. login, navigation, form submission).

Each test case must follow this EXACT JSON schema:
{{
  "id": "TC001",
  "objective": "Short description of what is being tested",
  "steps": [
    {{
      "stepNum": 1,
      "action": "tap" | "type" | "swipe",
      "resource_id": "<resource-id>",
      "value": "<text, only for type>",
      "description": "Human-readable step description"
    }}
  ],
  "expected_result": "What the user should see after all steps complete"
}}

Return ONLY a valid JSON array of test case objects. No markdown, no extra text.
Example: [ {{ "id": "TC001", ... }}, {{ "id": "TC002", ... }} ]"""

    return prompt