'use strict';

/**
 * llm.js — Vision Architecture LLM client (Architecture B)
 *
 * Follows the same interface/style as web/src/llmClient.js:
 *   callLLM(prompt) -> raw text or parsed object
 *   parseAction(response) -> normalised action
 *   executeAction(page, action, targetElement) -> Playwright execution
 *
 * Key difference from Architecture A:
 *   Actions use coordinates (x/y from the visual DOM) instead of CSS selectors,
 *   because YOLO + OCR produce bounding boxes, not DOM nodes.
 */

require('dotenv').config();

const Groq = require('groq-sdk');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) {
  throw new Error('Missing GROQ_API_KEY. Add it to your .env file in vision/.env');
}

const groq = new Groq({ apiKey: GROQ_API_KEY });

const MODEL =
  process.env.GROQ_MODEL || 'openai/gpt-oss-120b';

// Visual DOM prompts are short; a modest token budget avoids quota issues.
const MAX_TOKENS = Number(process.env.GROQ_MAX_TOKENS) || 700;
const TEMPERATURE = Number(process.env.GROQ_TEMPERATURE) || 0.2;
const STUB_MODE = process.env.STUB_LLM === 'true';

// ---------------------------------------------------------------------------
// Generic LLM call
// ---------------------------------------------------------------------------

async function callLLM(prompt, options = {}) {
  if (STUB_MODE) {
    console.warn('[llm] STUB MODE — returning done action');
    return { action: 'done', reason: 'stub' };
  }

  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new Error('callLLM: prompt must be a non-empty string');
  }

  const model = options.model || MODEL;
  const maxTokens = Number(options.maxTokens) || MAX_TOKENS;
  const temperature =
    typeof options.temperature === 'number' ? options.temperature : TEMPERATURE;

  console.log(`[llm] Calling Groq -> ${model} ...`);

  // One retry for transient failures only; do not retry quota errors.
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const completion = await groq.chat.completions.create({
        model,
        max_tokens: maxTokens,
        temperature,
        messages: [
          {
            role: 'system',
            content:
              'You are an AI agent for automated web application testing. ' +
              'Follow the user prompt exactly. ' +
              'When JSON output is requested, return valid JSON only.',
          },
          { role: 'user', content: prompt },
        ],
      });

      const rawText =
        completion?.choices?.[0]?.message?.content ?? '';

      if (typeof rawText !== 'string' || rawText.trim() === '') {
        throw new Error('LLM returned an empty response');
      }

      console.log('[llm] Raw response:', rawText.trim().slice(0, 200));
      return rawText.trim();
    } catch (err) {
      const status = err.status || err.statusCode || null;
      const message = err.message || String(err);
      console.error(`[llm] Attempt ${attempt} failed: ${message}`);

      if (status === 429 || message.includes('quota')) {
        throw err;
      }
      if (attempt >= maxAttempts) throw err;

      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}

/**
 * Extract and parse JSON from an LLM response.
 * Tolerates markdown fences and surrounding text.
 */
function extractJSON(rawText) {
  if (typeof rawText !== 'string') return rawText;

  const cleaned = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/\s*```$/, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (_) {
    // Try to find the first {...} or [...] block.
    const objectMatch = cleaned.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try { return JSON.parse(objectMatch[0]); } catch (_) {}
    }
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try { return JSON.parse(arrayMatch[0]); } catch (_) {}
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Action parsing (coordinate-based, per report System 2)
// ---------------------------------------------------------------------------

const VALID_ACTIONS = new Set(['click', 'fill', 'navigate', 'scroll', 'done']);

function parseAction(llmResponse) {
  if (STUB_MODE) {
    return { action: 'done', reason: 'stub' };
  }

  let obj = llmResponse;
  if (typeof llmResponse === 'string') {
    obj = extractJSON(llmResponse);
  }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { action: 'unknown', reason: 'unparseable response' };
  }

  const type = String(obj.action || '').toLowerCase();
  if (!VALID_ACTIONS.has(type)) {
    return { action: 'unknown', reason: `unsupported action "${type}"` };
  }

  return {
    action: type,
    x: typeof obj.x === 'number' ? obj.x : null,
    y: typeof obj.y === 'number' ? obj.y : null,
    value: typeof obj.value === 'string' ? obj.value : '',
    url: typeof obj.url === 'string' ? obj.url : '',
    elementId: obj.elementId || null,
    targetText: obj.target_text || obj.targetText || null,
    reason: obj.reason || '',
  };
}

// ---------------------------------------------------------------------------
// Coordinate-based Playwright execution
// ---------------------------------------------------------------------------

async function executeAction(page, action) {
  switch (action.action) {
    case 'click': {
      if (!Number.isFinite(action.x) || !Number.isFinite(action.y)) {
        throw new Error('executeAction: click requires numeric x and y coordinates');
      }
      await page.mouse.click(action.x, action.y);
      return;
    }

    case 'fill': {
      if (!Number.isFinite(action.x) || !Number.isFinite(action.y)) {
        throw new Error('executeAction: fill requires numeric x and y coordinates');
      }
      await page.mouse.click(action.x, action.y);
      await page.keyboard.press('Control+A').catch(() => {});
      await page.keyboard.type(action.value || 'test', { delay: 30 });
      return;
    }

    case 'navigate': {
      if (!action.url) {
        throw new Error('executeAction: navigate requires a url');
      }
      await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return;
    }

    case 'scroll': {
      await page.mouse.wheel(0, action.y || 600);
      return;
    }

    case 'done':
      return;

    default:
      throw new Error(`Unsupported action: ${action.action}`);
  }
}

module.exports = { callLLM, extractJSON, parseAction, executeAction };
