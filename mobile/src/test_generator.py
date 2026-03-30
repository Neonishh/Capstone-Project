"""
test_generator.py
Mobile equivalent of web/src/testGenerator.js

Responsibility:
  generate_test_cases(memory_log, output_path) — builds test case prompt,
  calls LLM, parses JSON array response, saves to mobile_test_cases.json.
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
        raw_response = call_llm(prompt)
    except Exception as e:
        print(f"[test_generator] LLM call failed: {e}")
        return []

    # call_llm may return a dict (stub/done) or a list — normalise
    if isinstance(raw_response, list):
        test_cases = raw_response
    elif isinstance(raw_response, dict):
        # Stub returns a single dict — wrap it or return empty
        if raw_response.get("action") == "done":
            print("[test_generator] LLM in stub mode — no test cases generated.")
            return []
        test_cases = [raw_response]
    else:
        test_cases = _parse_test_cases_json(str(raw_response))

    # Validate — each entry must have id, objective, steps, expected_result
    valid = []
    for tc in test_cases:
        if tc.get("id") and tc.get("objective") and isinstance(tc.get("steps"), list) and tc.get("expected_result"):
            valid.append(tc)
        else:
            print(f"[test_generator] Skipping malformed test case: {str(tc)[:80]}")

    _save_test_cases(valid, output_path)

    print(f"\n[test_generator] ✓ Generated {len(valid)} test case(s):")
    for tc in valid:
        print(f"  [{tc['id']}] {tc['objective']} ({len(tc['steps'])} steps)")

    return valid


def _parse_test_cases_json(raw_str: str) -> list:
    """
    Attempts JSON.parse on raw LLM output.
    Strips markdown fences and retries once on failure.
    Mirrors _parseTestCasesJSON() in testGenerator.js.
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
    except json.JSONDecodeError as e:
        print(f"[test_generator] JSON parse failed after stripping fences: {e}")
        return []


def _save_test_cases(test_cases: list, output_path: str) -> None:
    """Writes test case array to the given output path."""
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(test_cases, f, indent=2)
    print(f"[test_generator] Saved → {output_path}")
