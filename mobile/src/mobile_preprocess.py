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

    # Step 2: Deduplicate — use resource_id if available, otherwise use
    # bounds (position on screen) as the key. This keeps all toolbar icons
    # even when they share the same class and have no resource_id, because
    # they are at different screen positions.
    seen_keys = set()
    deduped = []
    for el in filtered:
        rid = el.get("resource_id")
        if rid:
            key = rid
        else:
            # Use bounds as fallback key — each unique position is unique element
            key = el.get("bounds") or el.get("class_name", "") + str(el.get("text", ""))
        if key in seen_keys:
            continue
        seen_keys.add(key)
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
    """
    Returns True if element has at least one useful identifier.
    Icons on toolbars often have no text/resource_id/content_desc but
    are still tappable — keep them if they are clickable.
    """
    has_label = bool(
        (el.get("text") or "").strip()
        or (el.get("resource_id") or "").strip()
        or (el.get("content_desc") or "").strip()
    )
    # Keep unlabelled elements if they are explicitly clickable — these
    # are typically icon buttons, FABs, toolbar actions etc.
    return has_label or el.get("clickable", False)


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
    # Last 8 steps for more context
    recent_steps = [
        {
            "step": s["step"],
            "action": s["action"],
            "target": s["target"],
            "from_url": s["from_url"].split("/")[-1],   # just activity name, shorter
            "to_url": s["to_url"].split("/")[-1],
        }
        for s in memory_log[-8:]
    ]

    tried_on_this_screen = sorted(get_tried_targets(memory_log, current_url))

    # All unique screens visited so far
    all_screens = sorted({s["from_url"].split("/")[-1] for s in memory_log})

    # Count untried elements on this screen
    untried_count = sum(
        1 for el in elements
        if (el.get("resource_id") or el.get("bounds", "") or el.get("tag", "")) not in tried_on_this_screen
    )

    compact_elements = [
        {
            "elementId": el["elementId"],
            "tag": el["tag"].split(".")[-1],
            "text": el.get("text", ""),
            "resource_id": el.get("resource_id", ""),
            "content_desc": el.get("content_desc", ""),
            "clickable": el.get("clickable", False),
            "bounds": el.get("bounds", ""),
        }
        for el in elements
    ]

    history_str = json.dumps(recent_steps, indent=2) if recent_steps else "No steps yet."
    tried_str = json.dumps(tried_on_this_screen) if tried_on_this_screen else "None — this screen is fresh."
    screens_str = json.dumps(all_screens) if all_screens else "None yet."

    prompt = f"""You are an AI mobile app tester. Your mission: EXHAUSTIVELY explore every screen and feature.

CURRENT SCREEN: {(current_url or "unknown").split("/")[-1]}
UNTRIED ELEMENTS ON THIS SCREEN: {untried_count} remaining

ALL SCREENS VISITED SO FAR:
{screens_str}

ELEMENTS ALREADY TRIED ON THIS SCREEN:
{tried_str}

ALL INTERACTIVE ELEMENTS ON SCREEN RIGHT NOW (pick from these):
{json.dumps(compact_elements, indent=2)}

RECENT ACTIONS (last 8 steps):
{history_str}

DECISION RULES — read carefully:

RULE 1 — NEVER tap something already in "ELEMENTS ALREADY TRIED ON THIS SCREEN".

RULE 2 — PRIORITY ORDER for choosing what to tap:
  a) Onboarding buttons: "Get Started", "Continue", "Next", "Allow", "Create Account",
     "Sign Up", "Log In", "Continue without sync/account", "I agree", "Accept" — tap these FIRST.
  b) Navigation elements: bottom nav tabs, top toolbar icons, menu (☰), overflow (⋮),
     FAB (+), search icon — these open new screens.
  c) List items and cards — tap to open details.
  d) Form fields (EditText) — fill with realistic data, then tap submit.
  e) Any other untried clickable element.
  f) Swipe up — if the screen is a scrollable list with more items.
  g) Back — ONLY after you have tapped EVERY element listed above AND there is truly
     nothing new to discover on this screen.

RULE 3 — "done" means the ENTIRE app is exhausted. Only return "done" if:
  - You have been to every reachable screen.
  - Every element on every screen has been tried.
  - There are truly no more unexplored paths.
  DO NOT return "done" just because the current screen is exhausted.

RULE 4 — DO NOT tap close/cancel/dismiss/skip/exit buttons unless:
  - Every other element on this screen has already been tried, AND
  - There is no productive action left.

Respond with EXACTLY this JSON (no markdown, no extra text):
{{
  "action": "tap" | "type" | "swipe" | "back" | "done",
  "elementId": <number from elements list above, or null for swipe/back/done>,
  "resource_id": "<resource-id string or empty string>",
  "value": "<text to type — only for type action, else empty string>",
  "reason": "<one sentence describing what this action will discover>"
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

IMPORTANT CONTEXT:
- Every test case runs from a FRESH app launch on the starting screen
- You MUST include all navigation steps needed to reach the target element
- Only use resource-ids that appear in the exploration log above
- The app starts at the first screen seen in the log

Generate 3 to 5 functional test cases that cover the key user flows discovered above.

Each test case must follow this EXACT JSON schema:
{{
  "id": "TC001",
  "objective": "Short description of what is being tested",
  "steps": [
    {{
      "stepNum": 1,
      "action": "tap" | "enterText" | "swipe" | "back",
      "target": "<resource-id of the element, copied exactly from the exploration log>",
      "value": "<text to type, only for enterText action>",
      "description": "Human-readable step description"
    }}
  ],
  "expected_result": "What the user should see after all steps complete"
}}

STRICT RULES:
- "action" must be ONLY one of: tap, enterText, swipe, back — NEVER use "verify" or any other word
- "target" must be a RESOURCE-ID (e.g. "org.fossify.contacts:id/contact_name") copied from the exploration log — NEVER use a raw class name like "android.widget.ImageButton" or "android.widget.TextView"
- If no resource-id is available for an element, use its visible text as the target instead
- Include ALL navigation steps needed to reach each element from the app start screen
- "value" is only needed for enterText actions, leave it out otherwise

Return ONLY a valid JSON array of test case objects. No markdown, no extra text.
Example: [ {{ "id": "TC001", ... }}, {{ "id": "TC002", ... }} ]"""

    return prompt