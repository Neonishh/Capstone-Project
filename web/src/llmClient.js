/**
 * llmClient.js
 * Interface definition (stub) — implemented by Navya G N (Day 2)
 *
 * This file defines the contract Nidhi's exploration loop (explore.js)
 * depends on. Navya fills in the actual OpenAI API calls.
 *
 * Functions this module MUST export:
 *   - callLLM(prompt)       → Promise<object>   parsed JSON response from LLM
 *   - parseAction(response) → object            safe parse with fallback
 *   - executeAction(page, action) → Promise<void>  performs click/fill/navigate
 *
 * Stub implementations are provided below so explore.js can run
 * in Day 1 without the LLM wired up.
 */

const STUB_MODE = process.env.STUB_LLM === 'true';  // set STUB_LLM=true to run without API key

/**
 * callLLM(prompt)
 * Sends prompt to OpenAI and returns parsed JSON action object.
 * STUB: returns a dummy navigate action.
 *
 * @param {string} prompt
 * @returns {Promise<object>}
 */
async function callLLM(prompt) {
  if (STUB_MODE) {
    console.warn('[llmClient] STUB MODE — returning dummy action');
    return {
      action: 'done',
      elementId: null,
      selector: '',
      value: '',
      reason: 'Stub mode active — LLM not wired yet',
    };
  }
  // TODO: Navya implements real OpenAI call here
  throw new Error('llmClient.callLLM() not yet implemented. Run with STUB_LLM=true for testing.');
}

/**
 * parseAction(llmResponse)
 * Safely parses raw LLM response string or object.
 * Returns a fallback action object on parse failure.
 *
 * @param {string|object} llmResponse
 * @returns {object}
 */
function parseAction(llmResponse) {
  if (STUB_MODE) {
    return { action: 'done', elementId: null, selector: '', value: '', reason: 'stub' };
  }
  // TODO: Navya implements robust JSON.parse with try/catch + retry logic
  throw new Error('llmClient.parseAction() not yet implemented.');
}

/**
 * executeAction(page, action)
 * Executes a parsed action on the Playwright page.
 *
 * @param {import('playwright').Page} page
 * @param {object} action  - { action, selector, value, url }
 * @returns {Promise<void>}
 */
async function executeAction(page, action) {
  if (STUB_MODE) {
    console.warn('[llmClient] STUB MODE — skipping executeAction');
    return;
  }
  // TODO: Navya implements click/fill/navigate dispatch
  throw new Error('llmClient.executeAction() not yet implemented.');
}

module.exports = { callLLM, parseAction, executeAction };
