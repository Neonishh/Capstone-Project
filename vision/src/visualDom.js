'use strict';

/**
 * visualDom.js
 * Builds compact prompts from the merged visual DOM for LLM consumption.
 * Keeps token usage low by summarising only meaningful elements.
 */

const MAX_ELEMENTS = 30;

function buildTestPrompt(visualDOM) {
  const elements = (visualDOM.elements || [])
    .filter((el) => el.text || el.yolo_label)
    .slice(0, MAX_ELEMENTS);

  const compact = elements.map((el) => ({
    id: el.id,
    type: el.type,
    text: el.text || null,
    center: {
      x: Math.round((el.bbox.x1 + el.bbox.x2) / 2),
      y: Math.round((el.bbox.y1 + el.bbox.y2) / 2),
    },
    // Detection confidence (0-1). Low values mean the element itself may be
    // misclassified — treat such elements as ambiguous.
    conf: typeof el.confidence?.yolo === 'number'
      ? Number(el.confidence.yolo.toFixed(2))
      : null,
  }));

  return `You are a QA engineer. Below is the detected UI of a web page (from YOLO object detection + OCR of a single static screenshot).

PAGE TEXT SUMMARY:
${(visualDOM.raw && visualDOM.raw.full_text ? visualDOM.raw.full_text : '').slice(0, 800)}

DETECTED ELEMENTS (id, type, text, centre coordinates, detection confidence):
${JSON.stringify(compact)}

EVIDENCE DISCIPLINE — every test case MUST separate three things:
1. "evidence": ONLY observable visual facts from the data above (element type, text, position, confidence). Quote the element ids you rely on.
2. "inferred_behavior": what you GUESS the element does at runtime (e.g. "probably opens a dropdown", "may navigate"). This is a hypothesis, NOT a fact.
3. "expected_result": the runtime-verifiable outcome the executor will check. It must be justified by the evidence and must remain true even if your inference is wrong.

HARD RULES:
- NEVER infer a navigation target (URL, page name, or destination) that is not present in the provided evidence. Do not fabricate URLs or page names.
- Do not assume a click causes navigation merely because an element looks like a button or link. A static screenshot cannot prove where (or whether) a click navigates.

CONFIDENCE POLICY for candidate elements (detection confidence "conf"):
- conf >= 0.6 (HIGH): normal action candidate.
- 0.3 <= conf < 0.6 (MEDIUM): allowed, but use conservative expectations (state-change/no-error outcomes, never navigation).
- conf < 0.3 (LOW), OR an element with no OCR text at all: EXCLUDE from generated tests entirely.

WORKFLOW RULES (IMPORTANT — tests must be realistic sequences, not single clicks):
- Each test case MUST contain 2 to 6 steps forming a meaningful user workflow. Single-action test cases are NOT acceptable unless the element genuinely offers nothing more (rare).
- Build workflows from the available element types, e.g.:
    * FORM WORKFLOW: fill two or more input fields (use their placeholders/labels for values), then click the submit/positive button.
    * NAVIGATION WORKFLOW: click a clear sidebar/menu link, then interact with something on the destination description if visible; otherwise assert the URL change.
    * CHOICE WORKFLOW: select a radio option AND check a checkbox, then verify state.
- Include at least one "scroll" step somewhere in the suite if the page text suggests content below the fold (long full_text). Scroll steps use {"action":"scroll","x":null,"y":600}.
- Ground every coordinate in the CURRENT detected elements. Never invent coordinates.

ASSERTION RULES (IMPORTANT):
- BUTTONS: by default expect an action-success or state-change outcome (value accepted, option selected, dropdown opens, validation message appears, in-page confirmation shown). Expect a URL change ONLY when there is strong evidence the button navigates (e.g. its text names another page/section AND it sits in a navigation region). Form submit buttons almost always stay on the same page and show an in-page confirmation — do NOT expect navigation from them.
- LINKS: a URL-change expectation is appropriate ONLY for elements whose detected type is "link" with a meaningful text label and reasonable confidence (conf >= 0.3). For such clear navigation links (e.g. sidebar/menu links whose text names another section), DO set "expect_navigation": true and assert the URL changes — that is the meaningful check for them. Do NOT treat generic text, footer fragments, or low-confidence detections (conf < 0.3) as navigational. For ambiguous elements, generate conservative expectations (e.g. "page remains rendered and no error occurs after clicking").
- ANIMATED / CAROUSEL / SLIDER / BANNER content: never assert exact text inside them (it may be mid-transition or partially rendered). Prefer structural outcomes: the page remains stable, the region is still present, or the click causes no error.
- FORM/INPUT tests: assert that the field accepts the typed value or that validation/confirmation appears in-page. Do not expect URL changes from form submission.
- Assertions must be observable so the executor can verify them: URL change (only when justified), field value accepted, radio/checkbox state change, scroll position change, non-empty rendered body, absence of errors.
- Set "expect_navigation" to true ONLY when the expected_result genuinely requires the URL to change; otherwise set it to false.
- Set "expected_text" to a short static string that should appear after the action ONLY if that text is visible in PAGE TEXT SUMMARY or element texts; otherwise use null. Never use expected_text for carousel/banner/animated content.
- Generate 4-6 workflow-based test cases covering different interaction types (form fill + submit, navigation, radio/checkbox choices, scrolling). Skip elements that are too ambiguous to test meaningfully rather than inventing behavior.

OUTPUT SCHEMA — each test case is a JSON object with exactly these fields:
- "id": short identifier (e.g. TC01)
- "objective": what to verify
- "evidence": array of at most 4 strings — the visual facts used (each under ~12 words)
- "inferred_behavior": string — your hypothesis in one short sentence
- "steps": array of { "action": "click"|"fill"|"navigate"|"scroll", "x": number|null, "y": number|null, "value": string, "target": {"type": string, "text": string} }
  Use element centre coordinates for click/fill. Use null coordinates for navigate and scroll. For scroll, y is the pixel amount to scroll down (e.g. 600).
  For every click/fill step, "target" MUST copy the element's type and text EXACTLY as given in DETECTED ELEMENTS (e.g. {"type":"button","text":"Submit"}). The executor uses target to re-find the element on the CURRENT screen after earlier steps may have navigated — coordinates alone become stale.
- "expected_result": string — runtime-verifiable outcome
- "expect_navigation": boolean
- "expected_text": string or null

Return ONLY a raw JSON array. No markdown, no explanation.`;
}

module.exports = { buildTestPrompt };
