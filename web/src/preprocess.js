'use strict';

/**
 * preprocess.js
 *
 * Responsibilities:
 *
 * 1. preprocessDOM()
 *    Reduce raw Playwright DOM information into useful elements for the LLM.
 *
 * 2. buildFlowDiscoveryPrompt()
 *    Ask the LLM to identify meaningful top-level user flows from the
 *    currently observed page.
 *
 * 3. buildExplorationPrompt()
 *    Ask the LLM to decide what meaningful interactions should be performed
 *    next during autonomous exploration.
 *
 * Important:
 *
 * This file contains NO website-specific knowledge.
 *
 * The LLM must infer functionality from the information extracted by
 * Playwright.
 */


// ============================================================================
// CONFIGURATION
// ============================================================================

const MAX_ELEMENTS = 60;


// Elements that are useful for browser interaction.
const ALLOWED_TAGS = new Set([
  'BUTTON',
  'INPUT',
  'A',
  'SELECT',
  'TEXTAREA'
]);


// Common semantic interactive roles.
const ALLOWED_ROLES = new Set([
  'button',
  'link',
  'tab',
  'checkbox',
  'radio',
  'switch',
  'combobox',
  'option',
  'menuitem'
]);


// ============================================================================
// DOM PREPROCESSING
// ============================================================================

/**
 * preprocessDOM(rawElements)
 *
 * Converts the raw DOM inventory from domExtractor.js into a compact,
 * LLM-friendly representation.
 *
 * The goal is NOT to remove everything.
 *
 * The goal is to:
 *
 *   raw DOM
 *      ↓
 *   useful interactive elements
 *      ↓
 *   remove obvious duplicates
 *      ↓
 *   prioritize meaningful controls
 *      ↓
 *   compact representation
 */
function preprocessDOM(rawElements) {

  if (!Array.isArray(rawElements)) {
    return [];
  }


  // --------------------------------------------------------------------------
  // Keep interactive elements.
  // --------------------------------------------------------------------------

  let filtered =
    rawElements.filter(el => {

      const tag =
        (el.tag || '').toUpperCase();

      const role =
        (el.role || '').toLowerCase();

      const validTag =
        ALLOWED_TAGS.has(tag);

      const validRole =
        ALLOWED_ROLES.has(role);

      const contentEditable =
        el.contentEditable === true;

      return (
        validTag ||
        validRole ||
        contentEditable
      );
    });


  // --------------------------------------------------------------------------
  // Remove clearly unusable elements.
  //
  // Do NOT require text/id/placeholder here because many legitimate
  // controls don't have visible text.
  // --------------------------------------------------------------------------

  filtered =
    filtered.filter(el => {

      if (el.disabled === true) {
        return false;
      }

      const selector =
        typeof el.selector === 'string'
          ? el.selector.trim()
          : '';

      const tag =
        typeof el.tag === 'string'
          ? el.tag.toUpperCase()
          : '';

      const role =
        typeof el.role === 'string'
          ? el.role.toLowerCase()
          : '';

      const hasIdentifier =
        Boolean(
          selector ||
          el.id ||
          el.name ||
          el.text ||
          el.label ||
          el.placeholder ||
          el.ariaLabel ||
          el.href
        );

      // For anonymous controls, retain them if they are clearly
      // interactive through their tag/role.
      const inherentlyInteractive =
        ALLOWED_TAGS.has(tag) ||
        ALLOWED_ROLES.has(role) ||
        el.contentEditable === true;

      return (
        hasIdentifier ||
        inherentlyInteractive
      );
    });


  // --------------------------------------------------------------------------
  // Remove duplicate selectors.
  // --------------------------------------------------------------------------

  const seenSelectors =
    new Set();

  filtered =
    filtered.filter(el => {

      const selector =
        typeof el.selector === 'string'
          ? el.selector.trim()
          : '';

      if (!selector) {
        return true;
      }

      if (seenSelectors.has(selector)) {
        return false;
      }

      seenSelectors.add(selector);

      return true;
    });


  // --------------------------------------------------------------------------
  // Remove duplicate semantic elements.
  //
  // We use several properties rather than text alone because two buttons
  // can legitimately have the same text.
  // --------------------------------------------------------------------------

  const seenSemanticKeys =
    new Set();

  filtered =
    filtered.filter(el => {

      const key = [
        el.tag || '',
        el.role || '',
        el.text || '',
        el.label || '',
        el.id || '',
        el.name || '',
        el.href || ''
      ]
        .join('|')
        .toLowerCase()
        .trim();

      if (!key) {
        return true;
      }

      if (seenSemanticKeys.has(key)) {
        return false;
      }

      seenSemanticKeys.add(key);

      return true;
    });


  // --------------------------------------------------------------------------
  // Prioritize elements.
  //
  // This does NOT mean the LLM must choose the first element.
  //
  // It simply puts potentially important controls earlier in the context.
  // --------------------------------------------------------------------------

  const priority = {

    // Main actions
    button: 0,
    submit: 0,

    // Navigation
    link: 1,
    a: 1,

    // Form controls
    input: 2,
    textarea: 2,
    select: 2,

    // Interactive widgets
    tab: 3,
    combobox: 3,
    checkbox: 3,
    radio: 3,
    switch: 3,
    option: 4,
    menuitem: 4
  };


  filtered.sort((a, b) => {

    const aTag =
      (a.tag || '').toLowerCase();

    const bTag =
      (b.tag || '').toLowerCase();

    const aRole =
      (a.role || '').toLowerCase();

    const bRole =
      (b.role || '').toLowerCase();

    const aKey =
      aRole || aTag;

    const bKey =
      bRole || bTag;

    const aPriority =
      priority[aKey] ?? 5;

    const bPriority =
      priority[bKey] ?? 5;

    return aPriority - bPriority;
  });


  // --------------------------------------------------------------------------
  // Limit context size.
  // --------------------------------------------------------------------------

  filtered =
    filtered.slice(0, MAX_ELEMENTS);


  // --------------------------------------------------------------------------
  // Reassign element IDs AFTER preprocessing.
  //
  // These IDs are only valid for the current DOM snapshot.
  // They are NOT persistent identifiers.
  // --------------------------------------------------------------------------

  filtered =
    filtered.map((el, index) => ({
      ...el,
      elementId: index
    }));


  return filtered;
}


// ============================================================================
// COMPACT ELEMENT REPRESENTATION
// ============================================================================

/**
 * compactElementForLLM(element)
 *
 * Removes information that is unnecessary for most LLM decisions.
 *
 * The full element remains available in the memory log.
 */
function compactElementForLLM(element, alreadyUsed = false) {

  return {
    elementId:
      element.elementId,

    tag:
      element.tag || '',

    role:
      element.role || '',

    text:
      element.text || '',

    label:
      element.label || '',

    id:
      element.id || null,

    name:
      element.name || null,

    type:
      element.inputType || '',

    placeholder:
      element.placeholder || '',

    ariaLabel:
      element.ariaLabel || '',

    href:
      element.href || '',

    required:
      Boolean(element.required),

    alreadyUsed
  };
}


// ============================================================================
// FLOW DISCOVERY PROMPT
// ============================================================================

/**
 * buildFlowDiscoveryPrompt(elements, pageMeta)
 *
 * The LLM looks at the homepage/application entry page and identifies
 * meaningful user-facing flows.
 *
 * IMPORTANT:
 *
 * There are NO hard-coded application names or URLs here.
 */
function buildFlowDiscoveryPrompt(elements, pageMeta = {}) {

  const compactElements =
    elements.map(
      element =>
        compactElementForLLM(element)
    );


  return `
You are an autonomous web application testing agent.

Your task is to identify the main meaningful user flows that can be
explored from the currently observed page.

PAGE:
${JSON.stringify({
  url: pageMeta.url || '',
  title: pageMeta.title || ''
}, null, 2)}

AVAILABLE INTERACTIVE ELEMENTS:
${JSON.stringify(compactElements, null, 2)}

Identify up to 5 meaningful user-facing flows.

A flow should represent a useful area of functionality such as:
- authentication
- search
- navigation
- forms
- shopping/product interaction
- account/profile functionality
- settings
- data manipulation
- filtering
- communication
- interactive widgets
- other functionality clearly suggested by the page

Do NOT assume functionality that is not supported by the observed page.

For each flow return:
- name: short meaningful name
- description: what the flow appears to accomplish
- entryElementId: the element that should be used to enter the flow, if applicable
- entryUrl: the href of that element if it is a link, otherwise ""

Only identify flows that are reasonably supported by the observed elements.

Return ONLY a valid JSON array.

Example structure:
[
  {
    "name": "User Search",
    "description": "Search for information using the available search controls",
    "entryElementId": 4,
    "entryUrl": ""
  }
]
`.trim();
}


// ============================================================================
// EXPLORATION PROMPT
// ============================================================================

/**
 * buildExplorationPrompt(elements, memoryLog, flow)
 *
 * The LLM decides what actions should be taken to explore the current
 * application state.
 *
 * It can return multiple related actions.
 *
 * Example:
 *
 *   fill name
 *   fill email
 *   click submit
 *
 * instead of requiring:
 *
 *   LLM → fill name
 *   LLM → fill email
 *   LLM → click submit
 *
 * This significantly reduces API calls.
 */
function buildExplorationPrompt(
  elements,
  memoryLog,
  flow = {}
) {

  // --------------------------------------------------------------------------
  // Determine which selectors have already been used.
  // --------------------------------------------------------------------------

  const usedSelectors =
    new Set(
      memoryLog
        .map(step =>
          step &&
          step.target_element_details
            ? step.target_element_details.selector
            : ''
        )
        .filter(Boolean)
    );


  // --------------------------------------------------------------------------
  // Build compact current-page element information.
  // --------------------------------------------------------------------------

  const compactElements =
    elements.map(element =>
      compactElementForLLM(
        element,
        usedSelectors.has(
          element.selector
        )
      )
    );


  // --------------------------------------------------------------------------
  // Only send recent history.
  //
  // The full memory remains on disk.
  // The exploration LLM only needs enough recent history to avoid repeating
  // actions and understand the current trajectory.
  // --------------------------------------------------------------------------

  const recentSteps =
    memoryLog
      .slice(-8)
      .map(step => ({
        step:
          step.step,

        action:
          step.action,

        target:
          step.target || '',

        selector:
          step.target_element_details
            ? step.target_element_details.selector || ''
            : '',

        value:
          step.value || '',

        from_url:
          step.from_url || '',

        to_url:
          step.to_url || '',

        success:
          step.success !== false,

        error:
          step.error || ''
      }));


  // --------------------------------------------------------------------------
  // Current flow information.
  // --------------------------------------------------------------------------

  const flowInfo = {
    name:
      flow.name || 'Unknown flow',

    description:
      flow.description || '',

    entryUrl:
      flow.entryUrl || ''
  };


  // --------------------------------------------------------------------------
  // Prompt.
  // --------------------------------------------------------------------------

  return `
You are an autonomous web UI exploration agent.

You are exploring an unfamiliar web application.

Your goal is to explore the functionality of the current flow using only
information observed from the website.

CURRENT FLOW:
${JSON.stringify(flowInfo, null, 2)}

CURRENT PAGE:
${JSON.stringify({
  url:
    memoryLog.length > 0
      ? memoryLog[memoryLog.length - 1].to_url || ''
      : flow.entryUrl || '',

  title:
    memoryLog.length > 0
      ? memoryLog[memoryLog.length - 1].to_title || ''
      : ''
}, null, 2)}

CURRENT INTERACTIVE ELEMENTS:
${JSON.stringify(compactElements, null, 2)}

RECENT EXPLORATION HISTORY:
${recentSteps.length > 0
  ? JSON.stringify(recentSteps, null, 2)
  : 'No previous actions in this flow.'}

YOUR TASK:

Determine the next meaningful actions required to explore this flow.

You should:
1. Prefer actions that reveal or exercise meaningful functionality.
2. Avoid repeatedly performing actions already completed.
3. Use the elementId supplied in the current element list.
4. Use "navigate" for links when navigation is appropriate.
5. Use "click" for buttons and interactive controls.
6. Use "fill" for text-entry fields.
7. Use realistic but safe test data when filling fields.
8. If a form is clearly part of the flow, fill relevant fields before submitting.
9. If an action changes the page or opens a new state, do not assume what the new
   page contains. The system will extract the new DOM and ask you again.
10. Do not invent elements, selectors, URLs, or functionality.
11. Do not navigate outside the current website origin unless the observed
    application clearly requires it.
12. Avoid destructive actions such as deleting real data unless the page is
    clearly a test/demo environment.
13. Stop when the meaningful functionality of the current flow appears
    sufficiently explored.

IMPORTANT:
- elementId values are valid only for the CURRENT DOM snapshot.
- Do not reuse an elementId from an older page state.
- Do not choose elements marked alreadyUsed unless using them again is necessary
  to complete the current flow.
- Do not invent a selector when a provided elementId can identify the target.

Return a SHORT action plan containing at most 5 related actions.

If the flow is already sufficiently explored, return:
{
  "actions": [
    {
      "action": "done",
      "elementId": null,
      "selector": "",
      "value": "",
      "url": "",
      "reason": "The meaningful functionality of this flow has been explored."
    }
  ]
}

Otherwise return:
{
  "actions": [
    {
      "action": "click" | "fill" | "navigate" | "done",
      "elementId": <number or null>,
      "selector": "<selector from current element list>",
      "value": "<value only for fill>",
      "url": "<observed href only for navigate>",
      "reason": "<short explanation>"
    }
  ]
}

Return ONLY valid JSON. No markdown. No explanation outside the JSON.
`.trim();
}


// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  preprocessDOM,
  buildFlowDiscoveryPrompt,
  buildExplorationPrompt
};