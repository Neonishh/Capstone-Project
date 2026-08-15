'use strict';

/**
 * contextBuilder.js
 *
 * Responsibility:
 *
 * Convert the raw memory log produced during Playwright exploration into
 * a structured context that can be given to the test-generation LLM.
 *
 * IMPORTANT:
 *
 * This file does NOT call the LLM.
 *
 * It organizes factual evidence that was actually observed during
 * exploration.
 *
 * Pipeline:
 *
 *   Playwright
 *       ↓
 *   Memory Log
 *       ↓
 *   Context Builder
 *       ↓
 *   Test Generator LLM
 *       ↓
 *   Test Cases
 *
 * The Context Builder should not invent functionality.
 */


// ============================================================================
// CONFIGURATION
// ============================================================================

const MAX_STEPS_PER_FLOW = 30;
const MAX_ELEMENTS_PER_FLOW = 40;
const MAX_ACTIONS_PER_FLOW = 30;
const MAX_ERRORS_PER_FLOW = 10;


// ============================================================================
// MAIN FUNCTION
// ============================================================================

/**
 * buildContext(memoryLog)
 *
 * Builds a structured representation of everything discovered during
 * exploration.
 *
 * Example output:
 *
 * {
 *   website: {
 *     origins: [...],
 *     pages: [...]
 *   },
 *
 *   flows: [
 *     {
 *       name: "Search",
 *       pages: [...],
 *       elements: [...],
 *       actions: [...],
 *       outcomes: [...],
 *       errors: [...]
 *     }
 *   ],
 *
 *   statistics: {...}
 * }
 */
function buildContext(memoryLog) {

  if (!Array.isArray(memoryLog)) {
    return createEmptyContext();
  }


  if (memoryLog.length === 0) {
    return createEmptyContext();
  }


  const flows =
    buildFlows(memoryLog);


  const pages =
    buildPages(memoryLog);


  const origins =
    extractOrigins(memoryLog);


  const statistics =
    buildStatistics(
      memoryLog,
      flows,
      pages
    );


  return {

    version: '1.0',

    website: {
      origins,
      pages
    },

    flows,

    statistics
  };
}


// ============================================================================
// BUILD FLOWS
// ============================================================================

/**
 * buildFlows(memoryLog)
 *
 * Groups exploration events by the flow assigned by the exploration system.
 *
 * Unlike the old flowSummarizer:
 *
 *   URL change ≠ new flow
 *
 * A single flow can contain multiple pages.
 */
function buildFlows(memoryLog) {

  const flowMap =
    new Map();


  for (const step of memoryLog) {

    if (
      !step ||
      typeof step !== 'object'
    ) {
      continue;
    }


    const flowName =
      normalizeFlowName(
        step.flow_name
      );


    if (!flowMap.has(flowName)) {

      flowMap.set(
        flowName,
        {
          name: flowName,

          pages: new Map(),

          elements: new Map(),

          actions: [],

          outcomes: [],

          errors: [],

          steps: []
        }
      );
    }


    const flow =
      flowMap.get(flowName);


    // ------------------------------------------------------------------------
    // Preserve raw step reference in structured form.
    // ------------------------------------------------------------------------

    flow.steps.push(
      buildStepContext(step)
    );


    // ------------------------------------------------------------------------
    // Add source and destination pages.
    // ------------------------------------------------------------------------

    addPageToFlow(
      flow,
      step.from_url,
      step.from_title
    );


    addPageToFlow(
      flow,
      step.to_url,
      step.to_title
    );


    // ------------------------------------------------------------------------
    // Add selected element.
    // ------------------------------------------------------------------------

    const element =
      step.target_element_details;


    if (element) {

      const elementKey =
        createElementKey(
          element
        );


      if (
        !flow.elements.has(elementKey)
      ) {

        flow.elements.set(
          elementKey,
          buildElementContext(
            element
          )
        );
      }
    }


    // ------------------------------------------------------------------------
    // Add action.
    // ------------------------------------------------------------------------

    flow.actions.push(
      buildActionContext(step)
    );


    // ------------------------------------------------------------------------
    // Add outcome.
    // ------------------------------------------------------------------------

    flow.outcomes.push(
      buildOutcomeContext(step)
    );


    // ------------------------------------------------------------------------
    // Add error if one occurred.
    // ------------------------------------------------------------------------

    if (
      step.success === false ||
      step.error
    ) {

      flow.errors.push({
        step:
          Number.isInteger(step.step)
            ? step.step
            : null,

        action:
          step.action || '',

        message:
          step.error || 'Unknown execution error',

        url:
          step.from_url || ''
      });
    }
  }


  // --------------------------------------------------------------------------
  // Convert Maps to JSON-friendly arrays.
  // --------------------------------------------------------------------------

  return Array.from(
    flowMap.values()
  ).map(flow => ({

    name:
      flow.name,

    pages:
      Array.from(
        flow.pages.values()
      ).slice(0, MAX_STEPS_PER_FLOW),


    elements:
      Array.from(
        flow.elements.values()
      ).slice(0, MAX_ELEMENTS_PER_FLOW),


    actions:
      flow.actions.slice(
        0,
        MAX_ACTIONS_PER_FLOW
      ),


    outcomes:
      flow.outcomes.slice(
        0,
        MAX_ACTIONS_PER_FLOW
      ),


    errors:
      flow.errors.slice(
        0,
        MAX_ERRORS_PER_FLOW
      ),


    steps:
      flow.steps.slice(
        0,
        MAX_STEPS_PER_FLOW
      )
  }));
}


// ============================================================================
// PAGE CONTEXT
// ============================================================================

function buildPages(memoryLog) {

  const pages =
    new Map();


  for (const step of memoryLog) {

    if (!step) {
      continue;
    }


    addPage(
      pages,
      step.from_url,
      step.from_title
    );


    addPage(
      pages,
      step.to_url,
      step.to_title
    );
  }


  return Array.from(
    pages.values()
  );
}


function addPageToFlow(
  flow,
  url,
  title
) {

  if (!url) {
    return;
  }


  const key =
    normalizeUrl(url);


  if (
    !flow.pages.has(key)
  ) {

    flow.pages.set(
      key,
      {
        url,
        path:
          getPath(url),
        title:
          title || ''
      }
    );
  }
}


function addPage(
  pages,
  url,
  title
) {

  if (!url) {
    return;
  }


  const key =
    normalizeUrl(url);


  if (
    !pages.has(key)
  ) {

    pages.set(
      key,
      {
        url,
        path:
          getPath(url),
        title:
          title || ''
      }
    );
  }
}


// ============================================================================
// ELEMENT CONTEXT
// ============================================================================

/**
 * buildElementContext(element)
 *
 * Converts the selected DOM element into a compact representation useful
 * for test generation.
 */
function buildElementContext(element) {

  return {

    elementId:
      element.elementId ?? null,

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

    selector:
      element.selector || '',

    href:
      element.href || '',

    inputType:
      element.inputType || '',

    placeholder:
      element.placeholder || '',

    ariaLabel:
      element.ariaLabel || '',

    required:
      element.required === true,

    disabled:
      element.disabled === true,

    contentEditable:
      element.contentEditable === true
  };
}


// ============================================================================
// ACTION CONTEXT
// ============================================================================

function buildActionContext(step) {

  const element =
    step.target_element_details || {};


  return {

    step:
      Number.isInteger(step.step)
        ? step.step
        : null,

    action:
      step.action || '',

    target:
      step.target || '',

    selector:
      element.selector || '',

    elementText:
      element.text || '',

    elementLabel:
      element.label || '',

    role:
      element.role || '',

    value:
      step.value || '',

    fromUrl:
      step.from_url || '',

    toUrl:
      step.to_url || '',

    success:
      step.success !== false,

    reason:
      step.reason || ''
  };
}


// ============================================================================
// OUTCOME CONTEXT
// ============================================================================

/**
 * buildOutcomeContext(step)
 *
 * Describes what changed after the action.
 *
 * This is factual.
 *
 * The Context Builder does not say:
 *
 *   "Login succeeded"
 *
 * unless the actual observed state supports such a conclusion.
 */
function buildOutcomeContext(step) {

  const urlChanged =
    Boolean(
      step.from_url &&
      step.to_url &&
      normalizeUrl(step.from_url) !==
      normalizeUrl(step.to_url)
    );


  return {

    step:
      Number.isInteger(step.step)
        ? step.step
        : null,

    action:
      step.action || '',

    success:
      step.success !== false,

    fromUrl:
      step.from_url || '',

    toUrl:
      step.to_url || '',

    urlChanged,

    titleChanged:
      Boolean(
        step.from_title &&
        step.to_title &&
        step.from_title !== step.to_title
      ),

    error:
      step.error || ''
  };
}


// ============================================================================
// STEP CONTEXT
// ============================================================================

function buildStepContext(step) {

  const element =
    step.target_element_details || {};


  return {

    step:
      Number.isInteger(step.step)
        ? step.step
        : null,

    action:
      step.action || '',

    target:
      step.target || '',

    value:
      step.value || '',

    element: {
      tag:
        element.tag || '',

      role:
        element.role || '',

      text:
        element.text || '',

      label:
        element.label || '',

      selector:
        element.selector || '',

      id:
        element.id || '',

      name:
        element.name || ''
    },

    from: {
      url:
        step.from_url || '',

      title:
        step.from_title || ''
    },

    to: {
      url:
        step.to_url || '',

      title:
        step.to_title || ''
    },

    success:
      step.success !== false,

    error:
      step.error || ''
  };
}


// ============================================================================
// ELEMENT KEY
// ============================================================================

function createElementKey(element) {

  if (
    element.id
  ) {
    return `id:${element.id}`;
  }


  if (
    element.selector
  ) {
    return `selector:${element.selector}`;
  }


  return [
    element.tag || '',
    element.role || '',
    element.text || '',
    element.label || '',
    element.name || '',
    element.href || ''
  ]
    .join('|')
    .toLowerCase();
}


// ============================================================================
// FLOW NAME
// ============================================================================

function normalizeFlowName(flowName) {

  if (
    typeof flowName !== 'string' ||
    flowName.trim() === ''
  ) {
    return 'Unknown Flow';
  }


  return flowName
    .replace(/\s+/g, ' ')
    .trim();
}


// ============================================================================
// URL HELPERS
// ============================================================================

function normalizeUrl(url) {

  if (!url) {
    return '';
  }


  try {

    const parsed =
      new URL(url);


    // Remove trailing slash from path.
    const pathname =
      parsed.pathname === '/'
        ? '/'
        : parsed.pathname.replace(
            /\/$/,
            ''
          );


    return (
      parsed.origin +
      pathname +
      parsed.search
    );

  } catch (_) {

    return String(url)
      .replace(/\/$/, '');
  }
}


function getPath(url) {

  if (!url) {
    return '';
  }


  try {

    return new URL(url).pathname;

  } catch (_) {

    return url;
  }
}


// ============================================================================
// ORIGIN EXTRACTION
// ============================================================================

function extractOrigins(memoryLog) {

  const origins =
    new Set();


  for (const step of memoryLog) {

    if (!step) {
      continue;
    }


    addOrigin(
      origins,
      step.from_url
    );


    addOrigin(
      origins,
      step.to_url
    );
  }


  return Array.from(
    origins
  );
}


function addOrigin(
  origins,
  url
) {

  if (!url) {
    return;
  }


  try {

    origins.add(
      new URL(url).origin
    );

  } catch (_) {
    // Ignore invalid URLs.
  }
}


// ============================================================================
// STATISTICS
// ============================================================================

function buildStatistics(
  memoryLog,
  flows,
  pages
) {

  const successfulSteps =
    memoryLog.filter(
      step =>
        step &&
        step.success !== false
    );


  const failedSteps =
    memoryLog.filter(
      step =>
        step &&
        step.success === false
    );


  const actionCounts = {};


  for (const step of memoryLog) {

    const action =
      step.action || 'unknown';


    actionCounts[action] =
      (actionCounts[action] || 0) + 1;
  }


  const uniqueSelectors =
    new Set();


  const uniqueElements =
    new Set();


  for (const step of memoryLog) {

    const element =
      step.target_element_details;


    if (!element) {
      continue;
    }


    if (element.selector) {
      uniqueSelectors.add(
        element.selector
      );
    }


    uniqueElements.add(
      createElementKey(element)
    );
  }


  return {

    totalSteps:
      memoryLog.length,

    successfulSteps:
      successfulSteps.length,

    failedSteps:
      failedSteps.length,

    flowCount:
      flows.length,

    pageCount:
      pages.length,

    uniqueElements:
      uniqueElements.size,

    uniqueSelectors:
      uniqueSelectors.size,

    actionCounts
  };
}


// ============================================================================
// EMPTY CONTEXT
// ============================================================================

function createEmptyContext() {

  return {

    version: '1.0',

    website: {
      origins: [],
      pages: []
    },

    flows: [],

    statistics: {
      totalSteps: 0,
      successfulSteps: 0,
      failedSteps: 0,
      flowCount: 0,
      pageCount: 0,
      uniqueElements: 0,
      uniqueSelectors: 0,
      actionCounts: {}
    }
  };
}


// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  buildContext
};