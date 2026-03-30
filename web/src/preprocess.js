'use strict';

const MAX_ELEMENTS = 50;
const ALLOWED_TAGS = new Set(['BUTTON', 'INPUT', 'A', 'SELECT', 'TEXTAREA']);

function preprocessDOM(rawElements) {
  if (!Array.isArray(rawElements)) return [];

  let filtered = rawElements.filter(el =>
    ALLOWED_TAGS.has((el.tag || '').toUpperCase())
  );

  filtered = filtered.filter(el => {
    const hasText        = el.text && el.text.trim() !== '';
    const hasId          = el.id && el.id.trim() !== '';
    const hasPlaceholder = el.placeholder && el.placeholder.trim() !== '';
    const hasAriaLabel   = el.ariaLabel && el.ariaLabel.trim() !== '';
    const hasHref        = el.href && el.href.trim() !== '' && el.href !== '#';
    const hasName        = el.name && el.name.trim() !== '';
    return hasText || hasId || hasPlaceholder || hasAriaLabel || hasHref || hasName;
  });

  const seenSelectors = new Set();
  filtered = filtered.filter(el => {
    const key = el.selector;
    if (seenSelectors.has(key)) return false;
    seenSelectors.add(key);
    return true;
  });

  const seenTexts = new Set();
  filtered = filtered.filter(el => {
    const t = el.text.trim().toLowerCase();
    if (t && seenTexts.has(t)) return false;
    if (t) seenTexts.add(t);
    return true;
  });

  const tagPriority = { 'BUTTON': 0, 'A': 1, 'INPUT': 2, 'SELECT': 3, 'TEXTAREA': 4 };
  filtered.sort((a, b) => {
    const pa = tagPriority[(a.tag || '').toUpperCase()] ?? 5;
    const pb = tagPriority[(b.tag || '').toUpperCase()] ?? 5;
    return pa - pb;
  });

  filtered = filtered.slice(0, MAX_ELEMENTS);
  filtered = filtered.map((el, index) => ({ ...el, elementId: index }));

  return filtered;
}

function buildExplorationPrompt(elements, memoryLog, flowName = 'unknown') {
  const recentSteps = memoryLog.slice(-5).map(s => ({
    step: s.step,
    action: s.action,
    selector: s.target_element_details ? s.target_element_details.selector : '',
    text: s.target_element_details ? s.target_element_details.text : '',
    from_url: s.from_url,
    to_url: s.to_url,
  }));

  const usedSelectors = new Set(
    memoryLog.map(s => s.target_element_details ? s.target_element_details.selector : '')
  );

  const compactElements = elements.map(el => ({
    elementId: el.elementId,
    tag: el.tag,
    text: el.text || '',
    selector: el.selector,
    inputType: el.inputType || '',
    placeholder: el.placeholder || '',
    href: el.href || '',
    alreadyUsed: usedSelectors.has(el.selector),
  }));

  return `You are an AI web exploration agent. You are currently exploring the "${flowName}" section of a website.

CURRENT PAGE ELEMENTS:
${JSON.stringify(compactElements, null, 2)}

RECENT STEPS TAKEN:
${recentSteps.length > 0 ? JSON.stringify(recentSteps, null, 2) : 'None — this is the first step in this flow.'}

YOUR GOAL for this flow ("${flowName}"):
- If this is "Elements": navigate into Text Box, fill the form, submit it.
- If this is "Forms": navigate into Practice Form, fill all fields, submit.
- If this is "Alerts": click Browser Windows or Alerts to trigger them.
- If this is "Widgets": interact with Accordian or Tabs.
- If this is "Interactions": try Sortable or Droppable.

STRICT RULES:
1. NEVER pick an element where alreadyUsed is true.
2. NEVER pick an element with empty text, empty id, empty placeholder, and empty href.
3. For anchor <a> tags, ALWAYS use action "navigate" with the full href as the url field. NEVER use "click" for links.
4. Only use "click" for BUTTON and INPUT elements.
5. If you just navigated to a new page, pick the most meaningful element on that new page.
6. If nothing useful remains or the flow goal is complete, return action "done".
7. Return ONLY raw JSON — no markdown, no explanation.
8. Do NOT navigate back to the homepage — stay focused on completing the current flow.
9. If the current page has input fields, fill them ALL before submitting.

Respond with EXACTLY:
{
  "action": "click" | "fill" | "navigate" | "done",
  "elementId": <number or null>,
  "selector": "<css selector>",
  "value": "<text to type, only for fill>",
  "url": "<full absolute url from href field, required for navigate>",
  "reason": "<one sentence>"
}`;
}

function buildTestCasePrompt(memoryLog) {
  const trimmedLog = memoryLog.map(s => ({
    step: s.step,
    action: s.action,
    target: s.target,
    selector: s.target_element_details ? s.target_element_details.selector : '',
    from_url: s.from_url,
    to_url: s.to_url,
    value: s.value || '',
  }));

  return `You are a QA engineer. Based on the following web UI exploration log, generate structured functional test cases.

EXPLORATION LOG:
${JSON.stringify(trimmedLog, null, 2)}

Generate 3 to 5 functional test cases covering key user flows discovered above.

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
  "expected_result": "What should happen after all steps complete"
}

Return ONLY a valid JSON array. No markdown, no extra text.`;
}

module.exports = { preprocessDOM, buildExplorationPrompt, buildTestCasePrompt };