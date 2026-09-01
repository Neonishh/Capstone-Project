'use strict';

/**
 * testGenerator.js
 *
 * Responsibility:
 *
 *   Convert structured exploration context into functional test cases
 *   using the LLM.
 *
 * Pipeline:
 *
 *   Memory Log
 *       ↓
 *   Context Builder
 *       ↓
 *   Test Generator
 *       ↓
 *   JSON Test Cases
 *       ↓
 *   Playwright Script Converter
 *
 * IMPORTANT:
 *
 * This file does NOT explore the website.
 * It does NOT extract DOM elements.
 * It does NOT execute Playwright actions.
 *
 * It only generates test cases from observed exploration context.
 */

const fs = require('fs');
const path = require('path');

const { callLLM } = require('./llmClient');


// ============================================================================
// CONFIGURATION
// ============================================================================

const TEST_CASES_PATH =
  path.join(
    __dirname,
    '..',
    'logs',
    'test_cases.json'
  );

const RAW_RESPONSE_PATH =
  path.join(
    __dirname,
    '..',
    'logs',
    'test_cases_raw_response.txt'
  );


// ----------------------------------------------------------------------------
// Number of test cases requested from the LLM.
//
// IMPORTANT: this is a PER-FLOW target, not a global cap.
//
// Each explored flow/feature gets its own small set of test cases: one
// positive and one negative. A negative case is only generated when the
// exploration evidence actually supports it (see buildTestCasePrompt
// rules 4 and 6); otherwise an additional positive variation is used
// instead of inventing one.
// ----------------------------------------------------------------------------

const TEST_CASES_PER_FLOW =
  Number(process.env.TEST_CASES_PER_FLOW) || 2;

// Hard ceiling on the whole run so a large number of flows can't blow past
// reasonable token/rate limits in a single call.
const MAX_TOTAL_TEST_CASES =
  Number(process.env.MAX_TOTAL_TEST_CASES) || 24;

// Keep test-generation request sizes predictable.
const MAX_FLOWS_FOR_TEST_GEN =
  Number(process.env.MAX_FLOWS_FOR_TEST_GEN) || 5;


// ============================================================================
// MAIN FUNCTION
// ============================================================================

/**
 * generateTestCases(context)
 *
 * @param {Object} context
 * @returns {Promise<Array>}
 */
async function generateTestCases(context) {

  if (
    !context ||
    typeof context !== 'object'
  ) {

    console.warn(
      '[testGenerator] Context is empty or invalid.'
    );

    return [];
  }


  const statistics =
    context.statistics || {};


  if (
    !statistics.totalSteps ||
    statistics.totalSteps === 0
  ) {

    console.warn(
      '[testGenerator] Context contains no exploration steps.'
    );

    return [];
  }


  const allFlows =
    Array.isArray(context.flows)
      ? context.flows
      : [];

  const selectedFlows =
    allFlows.slice(0, MAX_FLOWS_FOR_TEST_GEN);

  const flowCount =
    selectedFlows.length || (statistics.flowCount || 1);

  const targetTestCases =
    Math.min(
      MAX_TOTAL_TEST_CASES,
      Math.max(
        TEST_CASES_PER_FLOW,
        flowCount * TEST_CASES_PER_FLOW
      )
    );


  console.log(
    `[testGenerator] Generating ~${TEST_CASES_PER_FLOW} test case(s) per flow ` +
    `(target ${targetTestCases} total) from ` +
    `${statistics.totalSteps} exploration step(s) ` +
    `across ${flowCount} flow(s)...`
  );


  const finalCases = [];

  let llmFlowCount = 0;
  let fallbackFlowCount = 0;

  for (const flow of selectedFlows) {

    const flowContext =
      buildFlowScopedContext(
        context,
        flow
      );

    // ------------------------------------------------------------------
    // Scale the token budget to what THIS flow actually contains.
    //
    // A flow that's just "click a nav link" needs very little room, but
    // a flow with a large form (many fields) needs a lot more, because
    // each step in the JSON response costs real tokens. Using one fixed
    // budget for every flow (regardless of size) is what caused larger
    // flows like "Forms" to get silently truncated mid-response.
    // ------------------------------------------------------------------

    const flowElementCount =
      Array.isArray(flow.elements)
        ? flow.elements.length
        : 0;

    const estimatedStepsPerCase =
      Math.min(
        20,
        Math.max(4, flowElementCount + 2)
      );

    const baseMaxTokens =
      Math.min(
        4000,
        900 + TEST_CASES_PER_FLOW * (250 + estimatedStepsPerCase * 70)
      );

    let flowCases = [];
    let lastError = null;
    let lastRawResponse = null;

    // Try up to twice per flow before falling back to the deterministic
    // heuristic: once at the computed budget, and once more with a
    // larger budget and a stricter "compact JSON only" instruction. This
    // is what makes the fallback a genuine last resort instead of the
    // routine outcome it was when any truncation triggered it instantly.
    for (
      let attempt = 0;
      attempt < 2 && !flowCases.length;
      attempt++
    ) {

      const attemptMaxTokens =
        attempt === 0
          ? baseMaxTokens
          : Math.min(6500, Math.round(baseMaxTokens * 1.6));

      const attemptPrompt =
        attempt === 0
          ? buildTestCasePrompt(flowContext, TEST_CASES_PER_FLOW, TEST_CASES_PER_FLOW)
          : buildTestCasePrompt(flowContext, TEST_CASES_PER_FLOW, TEST_CASES_PER_FLOW) +
            '\n\nIMPORTANT: Your previous response was too long and got cut off ' +
            'before it finished. Return ONLY compact, minified JSON (no extra ' +
            'whitespace, no markdown fences, no commentary) so the full response ' +
            'fits.';

      try {

        lastRawResponse =
          await callLLM(
            attemptPrompt,
            {
              maxTokens: attemptMaxTokens,
              temperature: 0.2
            }
          );

        flowCases =
          parseTestCases(
            lastRawResponse
          );

        lastError = null;

      } catch (err) {
        lastError = err;
      }
    }

    if (!flowCases.length) {

      fallbackFlowCount++;

      console.warn(
        `[testGenerator] Flow "${flow.name || 'Unknown Flow'}" LLM generation ` +
        `failed after retry${lastError ? `: ${lastError.message}` : ''}. ` +
        'Using deterministic fallback (tagged, not LLM-generated).'
      );

      if (lastRawResponse) {
        saveRawResponse(
          `--- FLOW "${flow.name || 'Unknown Flow'}" (final failed attempt) ---\n` +
          (typeof lastRawResponse === 'string' ? lastRawResponse : JSON.stringify(lastRawResponse))
        );
      }

      flowCases =
        generateHeuristicTestCasesForFlow(
          flowContext,
          TEST_CASES_PER_FLOW
        ).map(testCase => ({
          ...testCase,
          generatedBy: 'fallback-heuristic',
          objective: `[Fallback - LLM unavailable] ${testCase.objective}`
        }));

    } else {

      llmFlowCount++;

      flowCases =
        flowCases.map(testCase => ({
          ...testCase,
          generatedBy: 'llm'
        }));
    }

    flowCases =
      validateTestCases(
        flowCases
      );

    finalCases.push(
      ...flowCases.slice(0, TEST_CASES_PER_FLOW)
    );

    if (finalCases.length >= targetTestCases) {
      break;
    }
  }

  console.log(
    `[testGenerator] ${llmFlowCount} flow(s) generated by the LLM, ` +
    `${fallbackFlowCount} flow(s) used the deterministic fallback.`
  );

  if (fallbackFlowCount > 0) {
    console.warn(
      `[testGenerator] WARNING: ${fallbackFlowCount} flow(s) fell back to ` +
      'template-based test cases (each marked "generatedBy": "fallback-heuristic" ' +
      'and prefixed "[Fallback - LLM unavailable]" in test_cases.json) because the ' +
      'LLM call failed even after a retry with a larger token budget. See ' +
      `${RAW_RESPONSE_PATH} for the raw response(s) that failed to parse.`
    );
  }

  // If flow list was missing or every flow call failed, keep the run usable.
  if (!finalCases.length) {
    const fallback =
      generateHeuristicTestCasesForFlow(
        context,
        TEST_CASES_PER_FLOW
      ).map(testCase => ({
        ...testCase,
        generatedBy: 'fallback-heuristic',
        objective: `[Fallback - LLM unavailable] ${testCase.objective}`
      }));

    finalCases.push(...fallback);
  }


  // --------------------------------------------------------------------------
  // Validate.
  // --------------------------------------------------------------------------

  let testCases =
    validateTestCases(
      finalCases
    );


  // --------------------------------------------------------------------------
  // Normalize IDs.
  // --------------------------------------------------------------------------

  testCases =
    normalizeTestCaseIds(
      testCases
    );


  // --------------------------------------------------------------------------
  // Save.
  // --------------------------------------------------------------------------

  saveTestCases(
    testCases
  );


  // --------------------------------------------------------------------------
  // Print summary.
  // --------------------------------------------------------------------------

  console.log(
    `\n[testGenerator] Generated ${testCases.length} test case(s):`
  );


  testCases.forEach(testCase => {

    console.log(
      `  [${testCase.id}] ` +
      `${testCase.objective} ` +
      `(${testCase.steps.length} step(s))`
    );
  });


  return testCases;
}


// ============================================================================
// BUILD TEST CASE PROMPT
// ============================================================================

/**
 * buildTestCasePrompt(context, testCasesPerFlow, targetTotal)
 *
 * Creates a compact but sufficiently detailed prompt for the test-generation
 * LLM.
 */
function buildTestCasePrompt(
  context,
  testCasesPerFlow = TEST_CASES_PER_FLOW,
  targetTotal = null
) {

  const compactContext =
    compactContextForLLM(
      context
    );

  const flowNames =
    Array.isArray(context.flows)
      ? context.flows.map(flow => flow.name || 'Unknown Flow')
      : [];


  return `
You are a senior QA engineer generating functional web application test cases.

The application was autonomously explored by a browser agent.

The information below contains ONLY functionality and UI information observed
during that exploration, organized by FLOW (one flow = one explored feature).

Your job is to convert the observed functionality into executable functional
test cases.

IMPORTANT RULES:

1. Do not invent pages, buttons, fields, URLs, or functionality that was not
   observed.

2. Use the observed selectors when possible.

3. Test cases should represent meaningful user behavior rather than simply
   repeating every exploration action.

4. PER-FLOW COVERAGE (this is the most important rule):
   For EACH flow listed below (${flowNames.length ? flowNames.join(', ') : 'see context'}),
   generate exactly ${testCasesPerFlow} test cases dedicated to that flow:
     - Exactly 1 "positive" test covering the normal/expected behavior
       observed for that flow.
     - Exactly 1 "negative" test ONLY if the exploration evidence for that
       flow supports one (e.g. a required field, a validation-looking
       control, an error state actually observed). If there is no such
       evidence, use an additional "positive" variation instead - do NOT
       invent a negative scenario just to fill the quota.
   A flow with only navigation evidence (no forms/inputs observed) should
   still get ${testCasesPerFlow} "positive" test cases covering different
   reasonable ways to exercise that navigation, rather than being skipped.

5. Do not skip a flow that appears in the context, even if it only has a
   small number of observed actions.

6. Do not create a negative test if the explored UI provides no reasonable
   evidence for it - use another positive variation instead.

7. Only two test case "type" values are allowed: "positive" and "negative".
   Do not use any other type value.

8. A test case must be executable using Playwright.

9. Every step must contain:
   - action
   - selector
   - value when required
   - description

   The "action" value MUST be exactly one of these (lowercase):
   "navigate", "click", "fill", "check", "uncheck", "select", "hover",
   "acceptAlert", "dismissAlert", "switchTab".
   Do not invent any other action name - a step with an unrecognized
   action will be discarded. Use:
     - "check"/"uncheck" for checkboxes or radio buttons
     - "select" for choosing an option in a <select> dropdown (put the
       option's visible text or value in "value")
     - "hover" for mouseover-triggered UI
     - "acceptAlert"/"dismissAlert" for native browser alert/confirm/
       prompt dialogs (selector can be empty)
     - "switchTab" for interacting with a newly opened browser tab or
       window (selector can be empty)

10. For navigation steps, use the observed URL when available.

11. Do not use XPath unless absolutely necessary.

12. Do not invent expected UI messages.

13. Expected results must be based on observed page transitions, titles,
    controls, or other evidence in the exploration context.

14. Return ${targetTotal ? `at most ${targetTotal}` : 'a reasonable number of'} test cases total across all flows.

OBSERVED EXPLORATION CONTEXT (grouped by flow):

${JSON.stringify(
  compactContext,
  null,
  2
)}

Return ONLY a valid JSON array.

Use EXACTLY this structure:

[
  {
    "id": "TC001",
    "objective": "Short description",
    "type": "positive",
    "flow": "Flow name",
    "preconditions": [
      "Optional precondition"
    ],
    "steps": [
      {
        "stepNum": 1,
        "action": "navigate",
        "selector": "",
        "value": "https://example.com/page",
        "description": "Open the observed page"
      },
      {
        "stepNum": 2,
        "action": "fill",
        "selector": "#example",
        "value": "test value",
        "description": "Enter the test value"
      },
      {
        "stepNum": 3,
        "action": "click",
        "selector": "#submit",
        "value": "",
        "description": "Submit the form"
      }
    ],
    "expected_result": "Describe the expected behavior based on observed evidence"
  }
]

Return ONLY the JSON array.
`.trim();
}


// ============================================================================
// COMPACT CONTEXT
// ============================================================================

/**
 * compactContextForLLM(context)
 *
 * The Context Builder already organizes the raw memory.
 *
 * This function removes information that is unlikely to be useful for
 * test generation, reducing token consumption.
 */
function compactContextForLLM(context) {

  const website =
    context.website || {};


  const flows =
    Array.isArray(context.flows)
      ? context.flows
      : [];


  return {

    website: {

      origins:
        Array.isArray(website.origins)
          ? website.origins
          : [],

      pages:
        Array.isArray(website.pages)
          ? website.pages.slice(0, 12).map(page => ({
            url:
              page.url || '',

            path:
              page.path || '',

            title:
              page.title || ''
          }))
          : []
    },


    flows:
      flows.slice(0, 5).map(
        flow => ({

          name:
            flow.name || '',


          pages:
            Array.isArray(flow.pages)
              ? flow.pages.slice(0, 6)
              : [],


          elements:
            Array.isArray(flow.elements)
              ? flow.elements.slice(0, 24).map(
                element => ({

                  tag:
                    element.tag || '',

                  text:
                    element.text || '',

                  id:
                    element.id || null,

                  class:
                    element.class || '',

                  selector:
                    element.selector || '',

                  inputType:
                    element.inputType || '',

                  placeholder:
                    element.placeholder || '',

                  required:
                    element.required === true
                })
              )
              : [],


          actions:
            Array.isArray(flow.actions)
              ? flow.actions.slice(0, 18).map(
                action => ({

                  step:
                    action.step,

                  action:
                    action.action || '',

                  target:
                    action.target || '',

                  selector:
                    action.selector || '',

                  elementText:
                    action.elementText || '',

                  elementTag:
                    action.elementTag || '',

                  value:
                    action.value || '',

                  fromUrl:
                    action.fromUrl || '',

                  toUrl:
                    action.toUrl || '',

                  success:
                    action.success !== false
                })
              )
              : [],


          outcomes:
            Array.isArray(flow.outcomes)
              ? flow.outcomes.slice(0, 12)
              : [],


          errors:
            Array.isArray(flow.errors)
              ? flow.errors.slice(0, 6)
              : []
        })
      ),


    statistics:
      context.statistics || {}
  };
}


// ============================================================================
// FLOW-SCOPED CONTEXT
// ============================================================================

function buildFlowScopedContext(context, flow) {

  if (!flow || typeof flow !== 'object') {
    return compactContextForLLM(context);
  }

  const flowName = flow.name || '';

  const flowContext = {
    ...context,
    flows: [flow],
    statistics: {
      ...(context.statistics || {}),
      flowCount: 1
    }
  };

  const compact = compactContextForLLM(flowContext);

  if (compact.statistics) {
    compact.statistics.selectedFlow = flowName;
  }

  return compact;
}


// ============================================================================
// DETERMINISTIC TEST-CASE FALLBACK
// ============================================================================

function generateHeuristicTestCasesForFlow(flowContext, requestedCount = 2) {

  const flows =
    Array.isArray(flowContext.flows)
      ? flowContext.flows
      : [];

  const flow = flows[0] || {};

  const flowName = flow.name || 'Explored Flow';

  const pages =
    Array.isArray(flow.pages)
      ? flow.pages
      : [];

  const elements =
    Array.isArray(flow.elements)
      ? flow.elements
      : [];

  const primaryUrl =
    pages.find(page => page && page.url && page.url.trim())?.url ||
    (Array.isArray(flow.actions)
      ? (flow.actions.find(action => action && action.toUrl)?.toUrl || '')
      : '');

  const fillable = elements.filter(element => {
    const tag = String(element.tag || '').toUpperCase();
    const type = String(element.inputType || '').toLowerCase();

    if (tag === 'TEXTAREA') {
      return true;
    }

    if (tag !== 'INPUT') {
      return false;
    }

    return !['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'reset', 'color', 'range'].includes(type);
  });

  const clickable = elements.filter(element => {
    const tag = String(element.tag || '').toUpperCase();
    const type = String(element.inputType || '').toLowerCase();

    return (
      tag === 'BUTTON' ||
      tag === 'A' ||
      (tag === 'INPUT' && ['submit', 'button'].includes(type))
    );
  });

  const requiredField =
    fillable.find(element => element.required === true);

  const submitCandidate =
    clickable.find(element => {
      const text = String(element.text || '').toLowerCase();
      const selector = String(element.selector || '').toLowerCase();

      return (
        text.includes('submit') ||
        text.includes('login') ||
        text.includes('register') ||
        selector.includes('submit')
      );
    }) || clickable[0];

  const positiveSteps = [];

  if (primaryUrl) {
    positiveSteps.push({
      stepNum: 1,
      action: 'navigate',
      selector: '',
      value: primaryUrl,
      description: 'Open the observed flow page'
    });
  }

  const fillTargets = fillable.slice(0, 2);

  for (const element of fillTargets) {
    if (!element.selector) {
      continue;
    }

    positiveSteps.push({
      stepNum: positiveSteps.length + 1,
      action: 'fill',
      selector: element.selector,
      value: buildSampleValue(element),
      description: 'Fill an observed input field'
    });
  }

  if (submitCandidate && submitCandidate.selector) {
    positiveSteps.push({
      stepNum: positiveSteps.length + 1,
      action: 'click',
      selector: submitCandidate.selector,
      value: '',
      description: 'Click an observed actionable control'
    });
  }

  const positiveCase = {
    id: 'TC001',
    objective: `Exercise observed ${flowName} flow with valid interactions`,
    type: 'positive',
    flow: flowName,
    preconditions: [],
    steps: positiveSteps,
    expected_result: 'The flow remains interactive and navigates or updates according to observed behavior.'
  };

  const cases = [];

  if (positiveSteps.length) {
    cases.push(positiveCase);
  }

  const canBuildNegative =
    requiredField &&
    requiredField.selector &&
    submitCandidate &&
    submitCandidate.selector &&
    primaryUrl;

  if (canBuildNegative && cases.length < requestedCount) {
    cases.push({
      id: 'TC002',
      objective: `Verify required field handling in ${flowName}`,
      type: 'negative',
      flow: flowName,
      preconditions: [],
      steps: [
        {
          stepNum: 1,
          action: 'navigate',
          selector: '',
          value: primaryUrl,
          description: 'Open the observed flow page'
        },
        {
          stepNum: 2,
          action: 'click',
          selector: submitCandidate.selector,
          value: '',
          description: 'Attempt to continue without filling required fields'
        }
      ],
      expected_result: 'Submission should not proceed successfully when required inputs are left empty.'
    });
  }

  while (cases.length < requestedCount && positiveSteps.length) {
    cases.push({
      id: `TC00${cases.length + 1}`,
      objective: `Repeat ${flowName} using an alternate observed control`,
      type: 'positive',
      flow: flowName,
      preconditions: [],
      steps: positiveSteps,
      expected_result: 'The observed controls remain usable across repeated executions.'
    });
  }

  return cases.slice(0, requestedCount);
}


function buildSampleValue(element) {
  const text =
    [
      element.text,
      element.placeholder,
      element.selector
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

  if (text.includes('email')) {
    return 'test@example.com';
  }

  if (text.includes('name')) {
    return 'Test User';
  }

  if (text.includes('phone') || text.includes('mobile')) {
    return '9876543210';
  }

  if (text.includes('address')) {
    return '123 Test Street';
  }

  return 'Sample Value';
}


// ============================================================================
// PARSE TEST CASES
// ============================================================================

function parseTestCases(rawResponse) {

  if (
    Array.isArray(rawResponse)
  ) {
    return rawResponse;
  }


  if (
    !rawResponse
  ) {
    throw new Error(
      'Empty LLM response'
    );
  }


  let text =
    typeof rawResponse === 'string'
      ? rawResponse.trim()
      : JSON.stringify(rawResponse);


  // Remove markdown fences.
  text =
    text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();


  // Direct JSON parse.
  try {

    const parsed =
      JSON.parse(text);


    return Array.isArray(parsed)
      ? parsed
      : [parsed];

  } catch (_) {
    // Continue with extraction.
  }


  // --------------------------------------------------------------------------
  // Try to extract an array from surrounding text.
  // --------------------------------------------------------------------------

  const start =
    text.indexOf('[');

  const end =
    text.lastIndexOf(']');


  if (
    start !== -1 &&
    end > start
  ) {

    const arrayText =
      text.slice(
        start,
        end + 1
      );


    try {

      const parsed =
        JSON.parse(arrayText);


      if (
        Array.isArray(parsed)
      ) {
        return parsed;
      }

    } catch (_) {
      // Continue.
    }
  }


  throw new Error(
    'LLM response does not contain a valid JSON test case array'
  );
}


// ============================================================================
// VALIDATE TEST CASES
// ============================================================================

function validateTestCases(
  testCases
) {

  if (
    !Array.isArray(testCases)
  ) {
    return [];
  }


  const validActions =
    new Set([
      'navigate',
      'click',
      'fill',
      'check',
      'uncheck',
      'select',
      'hover',
      'acceptalert',
      'dismissalert',
      'switchtab'
    ]);


  return testCases
    .filter(testCase => {

      if (
        !testCase ||
        typeof testCase !== 'object'
      ) {

        console.warn(
          '[testGenerator] Ignoring invalid test case.'
        );

        return false;
      }


      if (
        !testCase.objective ||
        typeof testCase.objective !== 'string'
      ) {

        console.warn(
          '[testGenerator] Test case has no valid objective.'
        );

        return false;
      }


      if (
        !Array.isArray(
          testCase.steps
        ) ||
        testCase.steps.length === 0
      ) {

        console.warn(
          `[testGenerator] "${testCase.objective}" has no valid steps.`
        );

        return false;
      }


      if (
        !testCase.expected_result ||
        typeof testCase.expected_result !== 'string'
      ) {

        console.warn(
          `[testGenerator] "${testCase.objective}" has no expected result.`
        );

        return false;
      }


      // ----------------------------------------------------------------------
      // Validate each step.
      // ----------------------------------------------------------------------

      const validSteps =
        testCase.steps.filter(step => {

          if (
            !step ||
            typeof step !== 'object'
          ) {
            return false;
          }


          const normalizedAction =
            typeof step.action === 'string'
              ? step.action.trim().toLowerCase()
              : '';

          if (
            !validActions.has(
              normalizedAction
            )
          ) {

            console.warn(
              `[testGenerator] Invalid action "${step.action}" in "${testCase.objective}".`
            );

            return false;
          }

          // Normalize casing so downstream consumers (e.g. a future
          // Playwright execution engine) see one consistent form.
          step.action = normalizedAction;


          const actionsWithoutSelector =
            new Set(['navigate', 'acceptalert', 'dismissalert', 'switchtab']);

          if (
            !actionsWithoutSelector.has(step.action) &&
            (
              typeof step.selector !== 'string' ||
              step.selector.trim() === ''
            )
          ) {

            console.warn(
              `[testGenerator] Missing selector in "${testCase.objective}".`
            );

            return false;
          }


          if (
            step.action === 'navigate' &&
            (
              typeof step.value !== 'string' ||
              step.value.trim() === ''
            )
          ) {

            console.warn(
              `[testGenerator] Missing navigation URL in "${testCase.objective}".`
            );

            return false;
          }


          return true;
        });


      if (
        validSteps.length === 0
      ) {
        return false;
      }


      testCase.steps =
        validSteps;


      return true;
    });
}


// ============================================================================
// NORMALIZE TEST CASE IDS
// ============================================================================

function normalizeTestCaseIds(
  testCases
) {

  return testCases.map(
    (testCase, index) => ({

      ...testCase,

      id:
        `TC${String(index + 1).padStart(3, '0')}`,

      steps:
        testCase.steps.map(
          (step, stepIndex) => ({

            ...step,

            stepNum:
              stepIndex + 1,

            selector:
              typeof step.selector === 'string'
                ? step.selector.trim()
                : '',

            value:
              typeof step.value === 'string'
                ? step.value
                : '',

            description:
              typeof step.description === 'string'
                ? step.description
                : ''
          })
        )
    })
  );
}


// ============================================================================
// SAVE TEST CASES
// ============================================================================

function saveTestCases(
  testCases
) {

  const directory =
    path.dirname(
      TEST_CASES_PATH
    );


  fs.mkdirSync(
    directory,
    {
      recursive: true
    }
  );


  fs.writeFileSync(
    TEST_CASES_PATH,
    JSON.stringify(
      testCases,
      null,
      2
    ),
    'utf8'
  );


  console.log(
    `[testGenerator] Saved → ${TEST_CASES_PATH}`
  );
}


// ============================================================================
// SAVE RAW RESPONSE
// ============================================================================

function saveRawResponse(
  rawResponse
) {

  try {

    const directory =
      path.dirname(
        RAW_RESPONSE_PATH
      );


    fs.mkdirSync(
      directory,
      {
        recursive: true
      }
    );


    const content =
      typeof rawResponse === 'string'
        ? rawResponse
        : JSON.stringify(
            rawResponse,
            null,
            2
          );


    fs.writeFileSync(
      RAW_RESPONSE_PATH,
      content,
      'utf8'
    );


    console.log(
      `[testGenerator] Raw response saved → ${RAW_RESPONSE_PATH}`
    );

  } catch (err) {

    console.error(
      '[testGenerator] Could not save raw response:',
      err.message
    );
  }
}


// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  generateTestCases,
  buildTestCasePrompt
};