'use strict';

require('dotenv').config();

const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');

const { getDOMElements, getPageMeta }           = require('./src/domExtractor');
const { storeStep, saveLog }                    = require('./src/memoryLog');
const { preprocessDOM, buildExplorationPrompt } = require('./src/preprocess');
const { callLLM, parseAction, executeAction }   = require('./src/llmClient');

const HOME_URL           = process.argv[2] || 'https://demoqa.com';
const MAX_FLOWS          = 5;
const MAX_STEPS_PER_FLOW = 12;
const LOG_DIR            = path.join(__dirname, 'logs');
const SCREENSHOT_DIR     = path.join(LOG_DIR, 'screenshots');
const MEMORY_LOG_PATH    = path.join(LOG_DIR, 'memory_log.json');

if (!fs.existsSync(LOG_DIR))        fs.mkdirSync(LOG_DIR, { recursive: true });
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// ── Discover flows from homepage ──────────────────────────────────────────────
async function discoverFlows(page, elements) {
  const compactElements = elements.map(el => ({
    elementId: el.elementId,
    tag: el.tag,
    text: el.text || '',
    selector: el.selector,
    href: el.href || '',
  }));

  const prompt = `You are a web exploration agent. Look at the homepage elements below and identify the main navigable sections.

HOMEPAGE ELEMENTS:
${JSON.stringify(compactElements, null, 2)}

Return a JSON array of flows to explore. Each flow must have:
- "name": the section name (e.g. "Elements", "Forms")
- "url": the full absolute URL from the href field

Only include top-level section links — ignore logo, footer, and external links.
Return ONLY a raw JSON array. No markdown, no explanation.

Example:
[
  { "name": "Elements", "url": "https://demoqa.com/elements" },
  { "name": "Forms", "url": "https://demoqa.com/forms" }
]`;

  try {
    const llmResponse = await callLLM(prompt);

    let parsed;
    if (Array.isArray(llmResponse)) {
      parsed = llmResponse;
    } else if (typeof llmResponse === 'string') {
      const clean = llmResponse
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/, '')
        .replace(/\s*```$/, '')
        .trim();
      parsed = JSON.parse(clean);
    } else if (typeof llmResponse === 'object' && llmResponse !== null) {
      // LLM returned a single object instead of array — wrap it
      parsed = [llmResponse];
    } else {
      parsed = [];
    }

    const valid = parsed.filter(f => f.name && f.url && f.url.startsWith('http'));
    console.log(`[explore] Discovered ${valid.length} flows:`, valid.map(f => f.name));
    return valid.slice(0, MAX_FLOWS);

  } catch (err) {
    console.error('[explore] Flow discovery failed:', err.message);
    return [];
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const memoryLog = [];
  const browser   = await chromium.launch({ headless: false });
  const page      = await browser.newPage();

  await page.route('**/*', route => {
    const url = route.request().url();
    const blocked = [
      'googlesyndication', 'googletagmanager', 'adsbygoogle', 'doubleclick',
      'google-analytics', 'googletagservices', 'amazon-adsystem', 'adnxs',
      'adsystem', 'moatads', 'scorecardresearch', 'outbrain', 'taboola',
      'disqus', 'cdn.carbonads', 'media.net'
    ];
    if (blocked.some(b => url.includes(b))) {
      route.abort();
    } else {
      route.continue();
    }
  });

  await page.setViewportSize({ width: 1280, height: 900 });

  // Step 1: Load homepage
  console.log(`[explore] Loading homepage: ${HOME_URL}`);
  try {
    await page.goto(HOME_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);
  } catch (err) {
    console.error('[explore] Failed to load homepage:', err.message);
    await browser.close();
    return;
  }

  // Step 2: Extract homepage elements and discover flows
  console.log('[explore] Extracting homepage elements...');
  let homeElements;
  try {
    const raw = await getDOMElements(page);
    homeElements = preprocessDOM(raw);
  } catch (err) {
    console.error('[explore] Homepage DOM extraction failed:', err.message);
    await browser.close();
    return;
  }

  console.log(`[explore] Homepage elements found: ${homeElements.length}`);
  const flows = await discoverFlows(page, homeElements);

  if (flows.length === 0) {
    console.error('[explore] No flows discovered — exiting.');
    await browser.close();
    return;
  }

  // Step 3: Explore each discovered flow
  let globalStep = 0;
  let flowNumber = 0;

  for (const flow of flows) {
    flowNumber++;
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`[explore] ▶ Flow ${flowNumber}/${flows.length}: ${flow.name} → ${flow.url}`);
    console.log(`${'═'.repeat(50)}`);

    try {
      if (flow.url && flow.url.startsWith('http')) {
        // Flow has a direct URL — navigate to it
        await page.goto(flow.url, { waitUntil: 'networkidle', timeout: 60000 });
      } else {
        console.error(`[explore] Flow "${flow.name}" has invalid URL — skipping.`);
        continue;
      }
      await page.waitForTimeout(3000);
    } catch (err) {
      console.error(`[explore] Failed to access flow "${flow.name}":`, err.message);
      continue;
    }

    let stepsInThisFlow = 0;

    while (stepsInThisFlow < MAX_STEPS_PER_FLOW) {
      console.log(`\n[explore] ══ Step ${globalStep} (Flow: ${flow.name}, flow-step: ${stepsInThisFlow}) ══`);

      const { url: fromUrl, title: fromTitle } = await getPageMeta(page);

      const screenshotBeforeName = `${globalStep + 1}_before.png`;
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, screenshotBeforeName),
        fullPage: true
      });

      let rawElements;
      try {
        rawElements = await getDOMElements(page);
      } catch (err) {
        console.error('[explore] DOM extraction failed:', err.message);
        rawElements = [];
      }

      const elements = preprocessDOM(rawElements);
      console.log(`[explore] Useful elements found: ${elements.length}`);

      if (elements.length === 0) {
        console.log('[explore] No useful elements — moving to next flow.');
        break;
      }

      const prompt = buildExplorationPrompt(elements, memoryLog, flow.name);

      let action;
      try {
        const llmResponse = await callLLM(prompt);
        action = parseAction(llmResponse);
        console.log('[explore] LLM decided:', JSON.stringify(action));
      } catch (err) {
        console.error('[explore] LLM failed:', err.message);
        storeStep(memoryLog, {
          step: globalStep, from_url: fromUrl, from_title: fromTitle,
          action: 'error', target: 'LLM_FAILURE',
          target_element_details: null,
          to_url: fromUrl, to_title: fromTitle,
          screenshot_before: `logs/screenshots/${screenshotBeforeName}`,
          screenshot_after:  `logs/screenshots/${screenshotBeforeName}`,
          timestamp: new Date().toISOString(),
        });
        saveLog(memoryLog, MEMORY_LOG_PATH);
        break;
      }

      if (action.action === 'done') {
        console.log(`[explore] Flow "${flow.name}" complete.`);
        break;
      }

      const targetElement = elements.find(el => el.elementId === action.elementId) || null;

      let screenshotAfterName = screenshotBeforeName;
      try {
        await executeAction(page, action);
        await page.waitForTimeout(2500);
        screenshotAfterName = `${globalStep + 1}_after.png`;
        await page.screenshot({
          path: path.join(SCREENSHOT_DIR, screenshotAfterName),
          fullPage: true
        });
      } catch (err) {
        console.error('[explore] Action execution failed:', err.message);
      }

      const { url: toUrl, title: toTitle } = await getPageMeta(page);

      storeStep(memoryLog, {
        step: globalStep, from_url: fromUrl, from_title: fromTitle,
        action: action.action,
        target: targetElement ? targetElement.tag : (action.url || action.selector || 'unknown'),
        target_element_details: targetElement || {
          elementId: action.elementId, tag: '', text: '',
          id: null, class: '', selector: action.selector,
        },
        to_url: toUrl, to_title: toTitle,
        screenshot_before: `logs/screenshots/${screenshotBeforeName}`,
        screenshot_after:  `logs/screenshots/${screenshotAfterName}`,
        timestamp: new Date().toISOString(),
      });

      saveLog(memoryLog, MEMORY_LOG_PATH);
      console.log(`[explore] Step ${globalStep} done: ${fromUrl} → ${toUrl}`);

      globalStep++;
      stepsInThisFlow++;
    }

    console.log(`[explore] ✓ Flow "${flow.name}" finished.`);
  }

  console.log('\n[explore]  All flows explored.');
  console.log(`[explore] Total steps logged: ${memoryLog.length}`);
  await browser.close();
})();