/**
 * preprocess.js
 * Day 2 – Nidhi K
 * Responsibility:
 *   1. preprocessDOM(rawElements)  — Filter, deduplicate, assign elementId,
 *      enforce 50-element token budget. Returns cleaned element array.
 *   2. buildExplorationPrompt(elements, memoryLog) — Constructs the LLM prompt
 *      for the next exploration action. Called BEFORE callLLM() (Navya's job).
 */

const MAX_ELEMENTS = 50;   // token budget cap
const ALLOWED_TAGS = new Set(['BUTTON', 'INPUT', 'A', 'SELECT', 'TEXTAREA']);

/**
 * preprocessDOM(rawElements)
 *
 * Filters raw DOM elements for usefulness:
 *  - Keep only ALLOWED_TAGS
 *  - Remove invisible/empty elements (no text, id, class, placeholder, or aria-label)
 *  - Remove duplicates by selector
 *  - Prioritise actionable elements: buttons first, then links, then inputs
 *  - Cap at MAX_ELEMENTS (50)
 *  - Re-assign sequential elementId (0, 1, 2...)
 *
 * @param {Array} rawElements  - Output from getDOMElements()
 * @returns {Array}            - Cleaned, capped element array
 */
function preprocessDOM(rawElements) {
  if (!Array.isArray(rawElements)) return [];

  // Step 1: Filter by tag
  let filtered = rawElements.filter(el =>
    ALLOWED_TAGS.has((el.tag || '').toUpperCase())
  );

  // Step 2: Remove useless elements — no identifying info at all
  filtered = filtered.filter(el => {
    const hasText = el.text && el.text.trim() !== '';
    const hasId   = el.id && el.id.trim() !== '';
    const hasClass = el.className && el.className.trim() !== '';
    const hasPlaceholder = el.placeholder && el.placeholder.trim() !== '';
    const hasAriaLabel = el.ariaLabel && el.ariaLabel.trim() !== '';
    const hasHref = el.href && el.href.trim() !== '' && el.href !== '#';
    const hasName = el.name && el.name.trim() !== '';
    return hasText || hasId || hasClass || hasPlaceholder || hasAriaLabel || hasHref || hasName;
  });

  // Step 3: Deduplicate by selector — keep first occurrence
  const seenSelectors = new Set();
  filtered = filtered.filter(el => {
    const key = el.selector || el.tag;
    if (seenSelectors.has(key)) return false;
    seenSelectors.add(key);
    return true;
  });

  // Step 4: Prioritise — BUTTON > A > INPUT/SELECT/TEXTAREA
  const tagPriority = { 'BUTTON': 0, 'A': 1, 'INPUT': 2, 'SELECT': 3, 'TEXTAREA': 4 };
  filtered.sort((a, b) => {
    const pa = tagPriority[(a.tag || '').toUpperCase()] ?? 5;
    const pb = tagPriority[(b.tag || '').toUpperCase()] ?? 5;
    return pa - pb;
  });

  // Step 5: Cap at MAX_ELEMENTS
  filtered = filtered.slice(0, MAX_ELEMENTS);

  // Step 6: Re-assign sequential elementId
  filtered = filtered.map((el, index) => ({
    ...el,
    elementId: index,
  }));

  return filtered;
}

/**
 * buildExplorationPrompt(elements, memoryLog)
 *
 * Constructs a structured LLM prompt instructing the model to decide the
 * next browser action based on the current page's elements and past steps.
 *
 * Output format expected from LLM:
 * {
 *   "action": "click" | "fill" | "navigate" | "done",
 *   "elementId": <number>,          // from the elements list
 *   "selector": "<css-selector>",
 *   "value": "<text to type>",      // only for fill
 *   "url": "<absolute url>",        // only for navigate
 *   "reason": "<short explanation>"
 * }
 *
 * @param {Array}  elements    - Preprocessed element array
 * @param {Array}  memoryLog   - Current exploration log (may be empty on step 0)
 * @returns {string}           - Prompt string to pass to callLLM()
 */
function buildExplorationPrompt(elements, memoryLog) {
  // Summarise last 5 steps to avoid token overflow on long explorations
  const recentSteps = memoryLog.slice(-5).map(s => ({
    step: s.step,
    action: s.action,
    target: s.target,
    from_url: s.from_url,
    to_url: s.to_url,
  }));

  // Compact element list — only fields the LLM needs
  const compactElements = elements.map(el => ({
    elementId: el.elementId,
    tag: el.tag,
    text: el.text || '',
    selector: el.selector,
    inputType: el.inputType || '',
    placeholder: el.placeholder || '',
    href: el.href || '',
  }));

  const prompt = `You are an AI web exploration agent. Your job is to decide the NEXT single browser action to systematically explore a web application and discover functional flows (login, navigation, form submission, etc.).

CURRENT PAGE ELEMENTS (filtered, max 50):
${JSON.stringify(compactElements, null, 2)}

RECENT EXPLORATION HISTORY (last 5 steps):
${recentSteps.length > 0 ? JSON.stringify(recentSteps, null, 2) : 'No steps yet — this is the first action.'}

RULES:
1. Prefer unexplored elements — avoid repeating selectors already in history.
2. Prefer meaningful actions: login forms, nav links, submit buttons.
3. For "fill" actions, provide realistic test data (e.g. email: "test@example.com").
4. If all elements are exhausted or you detect a loop, return action "done".
5. Do NOT return explanations — return ONLY valid JSON.

Respond with EXACTLY this JSON structure (no markdown, no extra text):
{
  "action": "click" | "fill" | "navigate" | "done",
  "elementId": <number from list above, or null for navigate/done>,
  "selector": "<css selector string>",
  "value": "<text to type, only for fill>",
  "url": "<absolute url, only for navigate>",
  "reason": "<one sentence explanation>"
}`;

  return prompt;
}

/**
 * buildTestCasePrompt(memoryLog)
 *
 * Constructs a prompt asking the LLM to generate structured functional
 * test cases from the completed exploration memory log.
 * NOTE: This is called in Day 3 from testGenerator.js — defined here
 * because it's part of Nidhi's prompt-building responsibility.
 *
 * @param {Array} memoryLog  - Full memory log (all steps)
 * @returns {string}         - Prompt string
 */
function buildTestCasePrompt(memoryLog) {
  // Trim log entries to essential fields to stay within token limits
  const trimmedLog = memoryLog.map(s => ({
    step: s.step,
    action: s.action,
    target: s.target,
    selector: s.target_element_details ? s.target_element_details.selector : '',
    from_url: s.from_url,
    to_url: s.to_url,
    value: s.value || '',
  }));

  const prompt = `You are a QA engineer. Based on the following web UI exploration log, generate structured functional test cases.

EXPLORATION LOG:
${JSON.stringify(trimmedLog, null, 2)}

Generate 3 to 5 functional test cases that cover the key user flows discovered above (e.g. login, navigation, form submission).

Each test case must follow this EXACT JSON schema:
{
  "id": "TC001",
  "objective": "Short description of what is being tested",
  "steps": [
    {
      "stepNum": 1,
      "action": "click" | "fill" | "navigate",
      "selector": "<css selector>",
      "value": "<text, only for fill>",
      "description": "Human-readable step description"
    }
  ],
  "expected_result": "What the user should see/happen after all steps complete"
}

Return ONLY a valid JSON array of test case objects. No markdown, no extra text.
Example: [ { "id": "TC001", ... }, { "id": "TC002", ... } ]`;

  return prompt;
}

module.exports = { preprocessDOM, buildExplorationPrompt, buildTestCasePrompt };
