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
// IMPORTANT: this is now a PER-FLOW target, not a global cap.
//
// Each explored flow/feature should end up with its own small set of test
// cases (ideally one positive, one negative, one boundary - but negative/
// boundary cases are only generated when the exploration evidence actually
// supports them; see buildTestCasePrompt rule 7).
// ----------------------------------------------------------------------------

const TEST_CASES_PER_FLOW =
  Number(process.env.TEST_CASES_PER_FLOW) || 3;

// Hard ceiling on the whole run so a large number of flows can't blow past
// reasonable token/rate limits in a single call.
const MAX_TOTAL_TEST_CASES =
  Number(process.env.MAX_TOTAL_TEST_CASES) || 24;


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


  const flowCount =
    Array.isArray(context.flows)
      ? context.flows.length
      : (statistics.flowCount || 1);

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


  // --------------------------------------------------------------------------
  // Build the test-generation prompt.
  // --------------------------------------------------------------------------

  const prompt =
    buildTestCasePrompt(
      context,
      TEST_CASES_PER_FLOW,
      targetTestCases
    );


  // --------------------------------------------------------------------------
  // Call LLM.
  //
  // maxTokens scales with the target test case count so a run with several
  // flows still has room to actually return all of them instead of being
  // truncated mid-response.
  // --------------------------------------------------------------------------

  let rawResponse;

  try {

    rawResponse =
      await callLLM(
        prompt,
        {
          maxTokens: Math.min(
            6000,
            600 + targetTestCases * 220
          ),
          temperature: 0.2
        }
      );

  } catch (err) {

    console.error(
      '[testGenerator] LLM call failed:',
      err.message
    );

    return [];
  }


  // --------------------------------------------------------------------------
  // Parse response.
  // --------------------------------------------------------------------------

  let testCases;

  try {

    testCases =
      parseTestCases(
        rawResponse
      );

  } catch (err) {

    console.error(
      '[testGenerator] Failed to parse LLM response:',
      err.message
    );


    saveRawResponse(
      rawResponse
    );


    return [];
  }


  // --------------------------------------------------------------------------
  // Validate.
  // --------------------------------------------------------------------------

  testCases =
    validateTestCases(
      testCases
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
   generate ${testCasesPerFlow} test cases dedicated to that flow:
     - Exactly 1 "positive" test covering the normal/expected behavior
       observed for that flow.
     - 1 "negative" test ONLY if the exploration evidence for that flow
       supports one (e.g. a required field, a validation-looking control,
       an error state actually observed). If there is no such evidence,
       use an additional "positive" variation instead - do NOT invent a
       negative scenario.
     - 1 "boundary" test ONLY if the exploration evidence for that flow
       supports one (e.g. a field with an observed length/format
       constraint, a min/max control). If there is no such evidence, use
       an additional "positive" variation instead - do NOT invent a
       boundary scenario.
   A flow with only navigation evidence (no forms/inputs observed) should
   still get ${testCasesPerFlow} "positive" test cases covering different
   reasonable ways to exercise that navigation, rather than being skipped.

5. Do not skip a flow that appears in the context, even if it only has a
   small number of observed actions.

6. Do not create a negative or boundary test if the explored UI provides no
   reasonable evidence for it - use another positive variation instead.

7. A test case must be executable using Playwright.

8. Every step must contain:
   - action
   - selector
   - value when required
   - description

9. For navigation steps, use the observed URL when available.

10. Do not use XPath unless absolutely necessary.

11. Do not invent expected UI messages.

12. Expected results must be based on observed page transitions, titles,
    controls, or other evidence in the exploration context.

13. Return ${targetTotal ? `at most ${targetTotal}` : 'a reasonable number of'} test cases total across all flows.

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
          ? website.pages.slice(0, 30).map(page => ({
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
      flows.slice(0, 10).map(
        flow => ({

          name:
            flow.name || '',


          pages:
            Array.isArray(flow.pages)
              ? flow.pages.slice(0, 10)
              : [],


          elements:
            Array.isArray(flow.elements)
              ? flow.elements.slice(0, 40).map(
                element => ({

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
                    element.required === true
                })
              )
              : [],


          actions:
            Array.isArray(flow.actions)
              ? flow.actions.slice(0, 30).map(
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

                  elementLabel:
                    action.elementLabel || '',

                  role:
                    action.role || '',

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
              ? flow.outcomes.slice(0, 30)
              : [],


          errors:
            Array.isArray(flow.errors)
              ? flow.errors.slice(0, 10)
              : []
        })
      ),


    statistics:
      context.statistics || {}
  };
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
      'fill'
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


          if (
            !validActions.has(
              step.action
            )
          ) {

            console.warn(
              `[testGenerator] Invalid action in "${testCase.objective}".`
            );

            return false;
          }


          if (
            step.action !== 'navigate' &&
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