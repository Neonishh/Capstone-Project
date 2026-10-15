"""
test_generator.py
Mobile equivalent of web/src/testGenerator.js

Responsibility:
  generate_test_cases(memory_log, output_path) — builds test case prompt,
  calls LLM in raw mode, parses JSON array response, saves to mobile_test_cases.json.
"""

import json
import os

from .mobile_preprocess import build_test_case_prompt
from .llm_client import call_llm


def generate_test_cases(memory_log: list, output_path: str) -> list:
    """
    Generates structured test cases from the completed exploration memory log.
    Mirrors generateTestCases() in testGenerator.js.

    Args:
        memory_log:  Full completed exploration log list
        output_path: Where to save mobile_test_cases.json

    Returns:
        Parsed and validated list of test case dicts (may be empty on LLM error)
    """
    if not memory_log:
        print("[test_generator] Memory log is empty — cannot generate test cases.")
        return []

    print(f"[test_generator] Building test case prompt from {len(memory_log)} steps...")
    prompt = build_test_case_prompt(memory_log)

    try:
        # IMPORTANT: response_format="raw" — the test-case response is a JSON
        # array, not a single exploration action, so it must NOT be routed
        # through parse_action() (which coerces everything into an
        # {action, elementId, resource_id, value, reason} dict).
        raw_response = call_llm(prompt, response_format="raw")
    except Exception as e:
        print(f"[test_generator] LLM call failed: {e}")
        print(
            "[test_generator] No test cases could be generated this run "
            "(the LLM call itself failed - see error above). Writing an "
            "empty file so the path isn't silently missing."
        )
        _save_test_cases([], output_path)
        return []

    if isinstance(raw_response, list):
        test_cases = raw_response
    else:
        test_cases = _parse_test_cases_json(str(raw_response))

    # Validate — each entry must have id, objective, steps, expected_result
    valid = []
    for tc in test_cases:
        if not isinstance(tc, dict):
            print(f"[test_generator] Skipping non-object test case entry: {str(tc)[:80]}")
            continue
        if tc.get("id") and tc.get("objective") and isinstance(tc.get("steps"), list) and tc.get("expected_result"):
            valid.append(tc)
        else:
            print(f"[test_generator] Skipping malformed test case: {str(tc)[:80]}")

    _save_test_cases(valid, output_path)

    print(f"\n[test_generator] Generated {len(valid)} test case(s):")
    for tc in valid:
        print(f"  [{tc['id']}] {tc['objective']} ({len(tc['steps'])} steps)")

    if not valid:
        print(
            "[test_generator] 0 test cases produced. If this wasn't a stub run, "
            "check that the LLM actually returned a JSON array matching the schema "
            "in build_test_case_prompt() — print raw_response above to inspect."
        )

    return valid


def _parse_test_cases_json(raw_str: str) -> list:
    """
    Attempts JSON.parse on raw LLM output.
    Strips markdown fences, then falls back to bracket-extraction if a
    preamble/postamble sentence is still wrapped around the JSON.
    Mirrors _parseTestCasesJSON() in testGenerator.js, extended for
    chattier local models that don't strictly follow "JSON only".
    """
    # Attempt 1: direct parse
    try:
        parsed = json.loads(raw_str)
        return parsed if isinstance(parsed, list) else [parsed]
    except json.JSONDecodeError:
        pass

    # Attempt 2: strip markdown fences
    cleaned = raw_str.replace("```json", "").replace("```", "").strip()
    try:
        parsed = json.loads(cleaned)
        return parsed if isinstance(parsed, list) else [parsed]
    except json.JSONDecodeError:
        pass

    # Attempt 3: bracket-extraction. Some models (especially smaller local
    # ones like llama3.1) add a plain-English sentence before or after the
    # JSON despite being told not to - e.g. "Here are the test cases:\n[...]".
    # Markdown-fence stripping alone doesn't remove that. This grabs
    # everything between the first '[' and the last ']', which survives
    # that kind of chatty wrapping.
    start = cleaned.find("[")
    end = cleaned.rfind("]")
    if start != -1 and end != -1 and end > start:
        candidate = cleaned[start:end + 1]
        try:
            parsed = json.loads(candidate)
            return parsed if isinstance(parsed, list) else [parsed]
        except json.JSONDecodeError as e:
            print(f"[test_generator] Bracket-extraction parse also failed: {e}")

    print(f"[test_generator] JSON parse failed after all attempts")
    print(f"[test_generator] Raw response was: {raw_str[:800]}")
    return []


def _save_test_cases(test_cases: list, output_path: str) -> None:
    """Writes test case array to the given output path."""
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(test_cases, f, indent=2)
    print(f"[test_generator] Saved -> {output_path}")