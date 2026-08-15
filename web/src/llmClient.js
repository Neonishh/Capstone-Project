'use strict';

/**
 * llmClient.js
 *
 * Responsibility:
 *
 * 1. Communicate with the LLM.
 * 2. Parse LLM responses.
 * 3. Normalize exploration plans.
 * 4. Execute LLM-selected actions through Playwright.
 *
 * Architecture:
 *
 *       DOM / Context
 *            |
 *            v
 *           LLM
 *            |
 *            v
 *      Structured JSON
 *            |
 *            v
 *       Playwright
 *
 * IMPORTANT:
 *
 * The LLM decides WHAT should happen.
 * Playwright decides HOW to physically execute it.
 *
 * This file contains no website-specific logic.
 */

require('dotenv').config();

const Groq = require('groq-sdk');


// ============================================================================
// CONFIGURATION
// ============================================================================

const GROQ_API_KEY =
  process.env.GROQ_API_KEY;

if (!GROQ_API_KEY) {
  throw new Error(
    'Missing GROQ_API_KEY. Add it to your .env file in web/.env'
  );
}


const groq =
  new Groq({
    apiKey: GROQ_API_KEY
  });


/**
 * Keep the model configurable through .env.
 *
 * Example:
 *
 * GROQ_MODEL=llama-3.3-70b-versatile
 *
 * This allows you to change models without modifying code.
 */
const MODEL =
  process.env.GROQ_MODEL ||
  'openai/gpt-oss-120b';


/**
 * Lower token limit keeps exploration inexpensive.
 *
 * The exploration prompt requests a short JSON action plan,
 * so there is no reason to allocate a huge response.
 */
const MAX_TOKENS =
  Number(process.env.GROQ_MAX_TOKENS) || 700;


const TEMPERATURE =
  Number(process.env.GROQ_TEMPERATURE) || 0.2;


// ============================================================================
// GENERIC LLM CALL
// ============================================================================

/**
 * callLLM(prompt, options)
 *
 * Sends a prompt to Groq and returns the raw model content.
 *
 * We intentionally do NOT force every LLM call to return an object.
 *
 * Different tasks may return:
 *
 *   Flow discovery → JSON array
 *   Exploration → JSON object
 *   Test generation → JSON array
 *
 * Parsing is handled by the corresponding parser.
 */
async function callLLM(prompt, options = {}) {

  if (
    typeof prompt !== 'string' ||
    prompt.trim() === ''
  ) {
    throw new Error(
      'callLLM: prompt must be a non-empty string'
    );
  }


  const model =
    options.model || MODEL;

  const maxTokens =
    Number(options.maxTokens) || MAX_TOKENS;

  const temperature =
    typeof options.temperature === 'number'
      ? options.temperature
      : TEMPERATURE;


  console.log(
    `[llmClient] Calling Groq → ${model} ...`
  );


  // --------------------------------------------------------------------------
  // One retry is useful for transient failures.
  //
  // We DO NOT repeatedly retry quota-exceeded errors because waiting 2 seconds
  // does not fix a daily token quota.
  // --------------------------------------------------------------------------

  const maxAttempts = 2;


  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt++
  ) {

    try {

      const completion =
        await groq.chat.completions.create({

          model,

          max_tokens:
            maxTokens,

          temperature,

          messages: [
            {
              role: 'system',
              content:
                'You are an AI agent for automated web application testing. ' +
                'Follow the user prompt exactly. ' +
                'When JSON output is requested, return valid JSON only.'
            },

            {
              role: 'user',
              content: prompt
            }
          ]
        });


      const rawText =
        completion &&
        completion.choices &&
        completion.choices[0] &&
        completion.choices[0].message
          ? completion.choices[0].message.content
          : '';


      if (
        typeof rawText !== 'string' ||
        rawText.trim() === ''
      ) {
        throw new Error(
          'LLM returned an empty response'
        );
      }


      console.log(
        '[llmClient] Raw response:',
        rawText.trim().slice(0, 300)
      );


      return rawText.trim();

    } catch (err) {

      const status =
        err.status ||
        err.statusCode ||
        null;

      const message =
        err.message || String(err);


      console.error(
        `[llmClient] Attempt ${attempt} failed:`,
        message
      );


      // ----------------------------------------------------------------------
      // Rate limit / quota handling
      // ----------------------------------------------------------------------

      if (
        status === 429 ||
        message.includes('429') ||
        message.toLowerCase().includes('rate limit')
      ) {

        const lower =
          message.toLowerCase();


        const dailyQuota =
          lower.includes('tokens per day') ||
          lower.includes('tpd') ||
          lower.includes('used') &&
          lower.includes('limit');


        if (dailyQuota) {

          throw new Error(
            'Groq daily token quota has been reached. ' +
            'Reduce LLM calls/tokens or wait until the quota resets. ' +
            `Original error: ${message}`
          );
        }


        // Temporary rate limit.
        if (attempt < maxAttempts) {

          const retryAfter =
            getRetryDelay(err);


          console.log(
            `[llmClient] Temporary rate limit. ` +
            `Retrying in ${retryAfter}ms...`
          );


          await sleep(
            retryAfter
          );

          continue;
        }
      }


      // ----------------------------------------------------------------------
      // Other temporary failures
      // ----------------------------------------------------------------------

      if (
        attempt < maxAttempts &&
        isRetryableError(err)
      ) {

        const delay =
          1500 * attempt;


        console.log(
          `[llmClient] Retrying in ${delay}ms...`
        );


        await sleep(delay);

        continue;
      }


      throw err;
    }
  }


  throw new Error(
    'LLM request failed'
  );
}


// ============================================================================
// RETRY HELPERS
// ============================================================================

function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}


function getRetryDelay(err) {

  // Groq/OpenAI-compatible errors may expose a retry-after value.
  const retryAfter =
    err &&
    (
      err.headers &&
      (
        err.headers['retry-after'] ||
        err.headers['Retry-After']
      )
    );


  if (retryAfter) {

    const seconds =
      Number(retryAfter);

    if (
      Number.isFinite(seconds)
    ) {
      return Math.min(
        seconds * 1000,
        30000
      );
    }
  }


  // Conservative fallback.
  return 5000;
}


function isRetryableError(err) {

  const status =
    err.status ||
    err.statusCode ||
    0;


  if (
    status >= 500 &&
    status <= 599
  ) {
    return true;
  }


  const message =
    (err.message || '').toLowerCase();


  return (
    message.includes('timeout') ||
    message.includes('temporarily unavailable') ||
    message.includes('connection reset')
  );
}


// ============================================================================
// JSON CLEANING
// ============================================================================

/**
 * cleanJSONResponse(response)
 *
 * Removes common markdown fences and surrounding text.
 *
 * The prompt asks for JSON-only responses, but models can occasionally
 * still return:
 *
 * ```json
 * {...}
 * ```
 *
 * or similar output.
 */
function cleanJSONResponse(response) {

  if (
    typeof response !== 'string'
  ) {
    return response;
  }


  let text =
    response.trim();


  // Remove markdown code fences.
  text =
    text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();


  return text;
}


// ============================================================================
// GENERIC JSON PARSER
// ============================================================================

function parseJSONResponse(response) {

  if (
    typeof response === 'object' &&
    response !== null
  ) {
    return response;
  }


  if (
    typeof response !== 'string'
  ) {
    throw new Error(
      'LLM response is neither JSON nor a string'
    );
  }


  const cleaned =
    cleanJSONResponse(response);


  // Direct parse.
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    // Continue to fallback extraction.
  }


  // --------------------------------------------------------------------------
  // Try to find an array.
  // --------------------------------------------------------------------------

  const arrayStart =
    cleaned.indexOf('[');

  const arrayEnd =
    cleaned.lastIndexOf(']');


  if (
    arrayStart !== -1 &&
    arrayEnd > arrayStart
  ) {

    const possibleArray =
      cleaned.slice(
        arrayStart,
        arrayEnd + 1
      );


    try {
      return JSON.parse(
        possibleArray
      );
    } catch (_) {
      // Continue.
    }
  }


  // --------------------------------------------------------------------------
  // Try to find an object.
  // --------------------------------------------------------------------------

  const objectStart =
    cleaned.indexOf('{');

  const objectEnd =
    cleaned.lastIndexOf('}');


  if (
    objectStart !== -1 &&
    objectEnd > objectStart
  ) {

    const possibleObject =
      cleaned.slice(
        objectStart,
        objectEnd + 1
      );


    try {
      return JSON.parse(
        possibleObject
      );
    } catch (_) {
      // Continue.
    }
  }


  throw new Error(
    'Could not parse valid JSON from LLM response'
  );
}


// ============================================================================
// EXPLORATION PLAN PARSER
// ============================================================================

/**
 * parseExplorationPlan(response)
 *
 * Expected structure:
 *
 * {
 *   "actions": [
 *     {
 *       "action": "fill",
 *       "elementId": 1,
 *       "selector": "#email",
 *       "value": "test@example.com",
 *       "url": "",
 *       "reason": "..."
 *     }
 *   ]
 * }
 */
function parseExplorationPlan(response) {

  const parsed =
    parseJSONResponse(response);


  // Some models may return the array directly.
  let actions;


  if (Array.isArray(parsed)) {
    actions = parsed;
  } else {
    actions =
      Array.isArray(parsed.actions)
        ? parsed.actions
        : [];
  }


  const normalized =
    actions
      .map(normalizeAction)
      .filter(Boolean);


  return {
    actions:
      normalized
  };
}


// ============================================================================
// ACTION NORMALIZATION
// ============================================================================

function normalizeAction(obj) {

  if (
    !obj ||
    typeof obj !== 'object'
  ) {
    return null;
  }


  const validActions =
    new Set([
      'click',
      'fill',
      'navigate',
      'done'
    ]);


  const action =
    typeof obj.action === 'string'
      ? obj.action.toLowerCase().trim()
      : '';


  if (
    !validActions.has(action)
  ) {
    return null;
  }


  return {

    action,

    elementId:
      Number.isInteger(obj.elementId)
        ? obj.elementId
        : null,

    selector:
      typeof obj.selector === 'string'
        ? obj.selector.trim()
        : '',

    value:
      typeof obj.value === 'string'
        ? obj.value
        : '',

    url:
      typeof obj.url === 'string'
        ? obj.url.trim()
        : '',

    reason:
      typeof obj.reason === 'string'
        ? obj.reason.trim()
        : ''
  };
}


// ============================================================================
// PLAYWRIGHT ACTION EXECUTION
// ============================================================================

/**
 * executeAction(page, action, targetElement)
 *
 * Playwright is responsible for actually performing the action.
 *
 * The LLM does NOT directly control the browser.
 */
async function executeAction(
  page,
  action,
  targetElement = null
) {

  if (
    !action ||
    typeof action !== 'object'
  ) {
    throw new Error(
      'executeAction: invalid action'
    );
  }


  const type =
    action.action;


  // ==========================================================================
  // DONE
  // ==========================================================================

  if (type === 'done') {

    console.log(
      '[llmClient] Exploration plan marked as done.'
    );

    return;
  }


  // ==========================================================================
  // Resolve selector
  // ==========================================================================

  let selector =
    action.selector ||
    (
      targetElement
        ? targetElement.selector
        : ''
    );


  // ==========================================================================
  // CLICK
  // ==========================================================================

  if (type === 'click') {

    if (!selector) {
      throw new Error(
        'executeAction: click has no selector'
      );
    }


    console.log(
      `[llmClient] Executing click: "${selector}"`
    );


    const locator =
      page.locator(selector).first();


    await locator.scrollIntoViewIfNeeded({
      timeout: 8000
    });


    await locator.click({
      timeout: 10000
    });


    return;
  }


  // ==========================================================================
  // FILL
  // ==========================================================================

  if (type === 'fill') {

    if (!selector) {
      throw new Error(
        'executeAction: fill has no selector'
      );
    }


    const value =
      (
        typeof action.value === 'string' &&
        action.value.trim() !== ''
      )
        ? action.value
        : getDefaultValue(
            targetElement,
            selector
          );


    console.log(
      `[llmClient] Executing fill: "${selector}" with "${value}"`
    );


    const locator =
      page.locator(selector).first();


    await locator.scrollIntoViewIfNeeded({
      timeout: 8000
    });


    await locator.fill(
      value,
      {
        timeout: 10000
      }
    );


    return;
  }


  // ==========================================================================
  // NAVIGATE
  // ==========================================================================

  if (type === 'navigate') {

    let target =
      action.url;


    // If the LLM did not provide a URL, use the observed element's href.
    if (
      !target &&
      targetElement &&
      targetElement.href
    ) {
      target =
        targetElement.href;
    }


    if (!target) {
      throw new Error(
        'executeAction: navigate has no URL'
      );
    }


    let absoluteUrl;


    try {

      absoluteUrl =
        new URL(
          target,
          page.url()
        ).href;

    } catch (err) {

      throw new Error(
        `Invalid navigation URL "${target}": ${err.message}`
      );
    }


    // ------------------------------------------------------------------------
    // Safety check:
    //
    // Don't allow the exploration agent to unexpectedly jump to unrelated
    // external domains.
    //
    // External navigation can be allowed later through configuration if
    // necessary.
    // ------------------------------------------------------------------------

    const currentOrigin =
      new URL(
        page.url()
      ).origin;


    const targetOrigin =
      new URL(
        absoluteUrl
      ).origin;


    if (
      currentOrigin !== targetOrigin
    ) {

      throw new Error(
        `Navigation blocked because target is outside the current website origin: ${absoluteUrl}`
      );
    }


    console.log(
      `[llmClient] Executing navigate: "${absoluteUrl}"`
    );


    await page.goto(
      absoluteUrl,
      {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      }
    );


    return;
  }


  throw new Error(
    `Unsupported action type: ${type}`
  );
}


// ============================================================================
// DEFAULT TEST VALUES
// ============================================================================

/**
 * Fallback values.
 *
 * These are NOT the main intelligence of the system.
 *
 * Normally the LLM should provide the value.
 * These are only used if the LLM leaves value empty.
 */
function getDefaultValue(
  targetElement,
  selector = ''
) {

  const combined =
    [
      targetElement
        ? targetElement.text
        : '',

      targetElement
        ? targetElement.label
        : '',

      targetElement
        ? targetElement.placeholder
        : '',

      targetElement
        ? targetElement.name
        : '',

      targetElement
        ? targetElement.ariaLabel
        : '',

      selector
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();


  if (
    combined.includes('email') ||
    combined.includes('mail')
  ) {
    return 'test@example.com';
  }


  if (
    combined.includes('password') ||
    combined.includes('passcode')
  ) {
    return 'TestPass123!';
  }


  if (
    combined.includes('phone') ||
    combined.includes('mobile') ||
    combined.includes('telephone')
  ) {
    return '9876543210';
  }


  if (
    combined.includes('first name') ||
    combined.includes('firstname')
  ) {
    return 'Test';
  }


  if (
    combined.includes('last name') ||
    combined.includes('lastname')
  ) {
    return 'User';
  }


  if (
    combined.includes('name') ||
    combined.includes('username')
  ) {
    return 'Test User';
  }


  if (
    combined.includes('search') ||
    combined.includes('query')
  ) {
    return 'test search';
  }


  if (
    combined.includes('city')
  ) {
    return 'Bangalore';
  }


  if (
    combined.includes('country')
  ) {
    return 'India';
  }


  if (
    combined.includes('address')
  ) {
    return '123 Test Street';
  }


  return 'Test Input';
}


// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  callLLM,
  parseExplorationPlan,
  executeAction
};