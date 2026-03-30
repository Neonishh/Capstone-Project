'use strict';

const Groq = require('groq-sdk');

const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) {
  throw new Error('Missing GROQ_API_KEY. Add it to your .env file in web/.env');
}
const groq = new Groq({ apiKey: GROQ_API_KEY });

const MODEL       = 'llama-3.3-70b-versatile';
const MAX_TOKENS  = 400;
const TEMPERATURE = 0.2;

const STUB_MODE = process.env.STUB_LLM === 'true';

async function callLLM(prompt) {
  if (STUB_MODE) {
    console.warn('[llmClient] STUB MODE — returning done');
    return { action: 'done', elementId: null, selector: '', value: '', reason: 'stub' };
  }

  console.log(`[llmClient] Calling Groq → ${MODEL} ...`);

  // Retry up to 3 times on transient failures
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const completion = await groq.chat.completions.create({
        model:       MODEL,
        max_tokens:  MAX_TOKENS,
        temperature: TEMPERATURE,
        messages: [
          {
            role: 'system',
            content:
              'You are a web UI exploration agent for automated testing. ' +
              'You MUST respond with a single raw JSON object only. ' +
              'Absolutely NO markdown, NO code blocks, NO backticks, NO explanation. ' +
              'Just the JSON object starting with { and ending with }.'
          },
          { role: 'user', content: prompt }
        ]
      });

      const rawText = completion.choices[0].message.content.trim();
      console.log('[llmClient] Raw response:', rawText.slice(0, 150));

      try {
        return JSON.parse(rawText);
      } catch (_) {
        console.warn('[llmClient] Response needs cleaning — parseAction() will handle it');
        return rawText;
      }

    } catch (err) {
      console.error(`[llmClient] Attempt ${attempt} failed:`, err.message);
      if (attempt < 3) {
        console.log('[llmClient] Retrying in 2 seconds...');
        await new Promise(r => setTimeout(r, 2000));
      } else {
        throw err; // re-throw after 3 failures so explore.js can log it properly
      }
    }
  }
}

function parseAction(llmResponse) {
  if (STUB_MODE) {
    return { action: 'done', elementId: null, selector: '', value: '', url: '', reason: 'stub' };
  }

  if (typeof llmResponse === 'object' && llmResponse !== null && !Array.isArray(llmResponse)) {
    return _normaliseAction(llmResponse);
  }

  if (typeof llmResponse === 'string') {
    const trimmed = llmResponse.trim();

    try { return _normaliseAction(JSON.parse(trimmed)); } catch (_) {}

    const noFences = trimmed
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/, '')
      .replace(/\s*```$/, '')
      .trim();
    try { return _normaliseAction(JSON.parse(noFences)); } catch (_) {}

    const match = trimmed.match(/\{[\s\S]*?\}/);
    if (match) { try { return _normaliseAction(JSON.parse(match[0])); } catch (_) {} }

    const matchGreedy = trimmed.match(/\{[\s\S]*\}/);
    if (matchGreedy) { try { return _normaliseAction(JSON.parse(matchGreedy[0])); } catch (_) {} }
  }

  console.error('[llmClient] parseAction: all strategies failed, raw:', JSON.stringify(llmResponse).slice(0, 300));
  return { action: 'done', elementId: null, selector: '', value: '', url: '', reason: 'parse_failed' };
}

function _normaliseAction(obj) {
  const VALID_ACTIONS = ['click', 'fill', 'navigate', 'done'];
  return {
    action:    VALID_ACTIONS.includes(obj.action) ? obj.action : 'done',
    elementId: typeof obj.elementId === 'number'  ? obj.elementId : null,
    selector:  typeof obj.selector  === 'string'  ? obj.selector.trim() : '',
    value:     typeof obj.value     === 'string'  ? obj.value : '',
    url:       typeof obj.url       === 'string'  ? obj.url : '',
    reason:    typeof obj.reason    === 'string'  ? obj.reason : '',
  };
}

async function executeAction(page, action) {
  if (STUB_MODE) { console.warn('[llmClient] STUB MODE — skipping executeAction'); return; }

  const { action: type, selector, value, url } = action;

  switch (type) {
  case 'click': {
    if (!selector) throw new Error('executeAction: click missing selector');
    console.log(`[llmClient] Executing: click "${selector}"`);

    try {
      // If the element has an href, navigate directly — more reliable than clicking
      const href = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? el.getAttribute('href') : null;
      }, selector).catch(() => null);

      if (href && href.startsWith('http')) {
        await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 20000 });
      } else if (href && href.startsWith('/')) {
        const base = new URL(page.url()).origin;
        await page.goto(base + href, { waitUntil: 'domcontentloaded', timeout: 20000 });
      } else {
        // Not a link — do normal click
        await page.click(selector, { timeout: 8000 });
      }
    } catch (firstErr) {
      try {
        await page.locator(`text=${selector}`).first().click({ timeout: 5000 });
      } catch (_) {
        throw firstErr;
      }
    }
    break;
  }
    case 'fill': {
      if (!selector) throw new Error('executeAction: fill missing selector');
      const textToType = (value && value.trim()) ? value : _defaultValue(selector);
      console.log(`[llmClient] Executing: fill "${selector}" with "${textToType}"`);
      try {
        await page.fill(selector, textToType, { timeout: 8000 });
      } catch (_) {
        await page.click(selector, { timeout: 5000 });
        await page.fill(selector, textToType, { timeout: 5000 });
      }
      break;
    }
    case 'navigate': {
      const target = url || selector;
      if (!target) throw new Error('executeAction: navigate missing url');
      const absolute = target.startsWith('http') ? target : new URL(target, page.url()).href;
      console.log(`[llmClient] Executing: navigate "${absolute}"`);
      await page.goto(absolute, { waitUntil: 'domcontentloaded', timeout: 20000 });
      break;
    }
    case 'done': {
      console.log('[llmClient] Action is "done" — exploration complete');
      break;
    }
    default: {
      console.warn(`[llmClient] Unknown action type: "${type}" — skipping`);
    }
  }
}

function _defaultValue(selector) {
  const s = selector.toLowerCase();
  if (s.includes('email') || s.includes('mail'))    return 'test@example.com';
  if (s.includes('password') || s.includes('pass')) return 'TestPass123!';
  if (s.includes('user') || s.includes('name'))     return 'testuser';
  if (s.includes('phone') || s.includes('mobile'))  return '9876543210';
  if (s.includes('search') || s.includes('query'))  return 'test search';
  if (s.includes('first'))                           return 'Test';
  if (s.includes('last'))                            return 'User';
  if (s.includes('address') || s.includes('city'))  return 'Bangalore';
  return 'test_input';
}

module.exports = { callLLM, parseAction, executeAction };