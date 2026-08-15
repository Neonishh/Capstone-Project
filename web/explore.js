'use strict';

/**
 * explore.js
 *
 * Architecture:
 *
 * Homepage
 *    ↓
 * Playwright extracts DOM
 *    ↓
 * LLM selects 2–3 major application features
 *    ↓
 * Playwright enters each selected feature
 *    ↓
 * Playwright deterministically exercises the controls
 *    ↓
 * Memory Log
 *    ↓
 * Context Builder
 *    ↓
 * Test Generator LLM
 *
 * IMPORTANT:
 *
 * The LLM is NOT called for every textbox/button/checkbox.
 *
 * The LLM is used for semantic feature selection.
 * Playwright performs the detailed browser interaction.
 */

require('dotenv').config();

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const {
  getDOMElements,
  getPageMeta
} = require('./src/domExtractor');

const {
  storeStep,
  saveLog,
  clearLog
} = require('./src/memoryLog');

const {
  preprocessDOM
} = require('./src/preprocess');

const {
  callLLM
} = require('./src/llmClient');

const {
  buildContext
} = require('./src/contextBuilder');

const {
  generateTestCases
} = require('./src/testGenerator');


// ============================================================================
// CONFIGURATION
// ============================================================================

const HOME_URL =
  process.argv[2] ||
  'https://demoqa.com';


/**
 * IMPORTANT:
 *
 * Only 2–3 major homepage features are selected.
 */
const MAX_FLOWS =
  Number(process.env.MAX_FLOWS) || 3;


/**
 * Maximum number of pages that can be entered while exploring
 * one selected feature.
 *
 * This prevents accidentally crawling an entire website.
 */
const MAX_PAGES_PER_FLOW =
  Number(process.env.MAX_PAGES_PER_FLOW) || 3;


/**
 * Maximum number of interactions performed on one page.
 */
const MAX_ACTIONS_PER_PAGE =
  Number(process.env.MAX_ACTIONS_PER_PAGE) || 30;


/**
 * Screenshots are optional.
 *
 * .env:
 *
 * CAPTURE_SCREENSHOTS=true
 */
const CAPTURE_SCREENSHOTS =
  process.env.CAPTURE_SCREENSHOTS === 'true';


const LOG_DIR =
  path.join(__dirname, 'logs');


const SCREENSHOT_DIR =
  path.join(
    LOG_DIR,
    'screenshots'
  );


const MEMORY_LOG_PATH =
  path.join(
    LOG_DIR,
    'memory_log.json'
  );


const CONTEXT_PATH =
  path.join(
    LOG_DIR,
    'context.json'
  );


// ============================================================================
// DIRECTORY SETUP
// ============================================================================

function ensureDirectories() {

  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(
      LOG_DIR,
      { recursive: true }
    );
  }

  if (
    CAPTURE_SCREENSHOTS &&
    !fs.existsSync(SCREENSHOT_DIR)
  ) {
    fs.mkdirSync(
      SCREENSHOT_DIR,
      { recursive: true }
    );
  }
}


// ============================================================================
// SCREENSHOT
// ============================================================================

async function captureScreenshot(page, filename) {

  if (!CAPTURE_SCREENSHOTS) {
    return '';
  }

  const fullPath =
    path.join(
      SCREENSHOT_DIR,
      filename
    );

  await page.screenshot({
    path: fullPath,
    fullPage: true
  });

  return `logs/screenshots/${filename}`;
}


// ============================================================================
// REQUEST BLOCKING
// ============================================================================

async function setupRequestBlocking(page) {

  await page.route(
    '**/*',
    async route => {

      const url =
        route.request().url();

      const blocked = [
        'googlesyndication',
        'googletagmanager',
        'adsbygoogle',
        'doubleclick',
        'google-analytics',
        'googletagservices',
        'amazon-adsystem',
        'adnxs',
        'adsystem',
        'moatads',
        'scorecardresearch',
        'outbrain',
        'taboola',
        'disqus',
        'cdn.carbonads',
        'media.net'
      ];

      if (
        blocked.some(
          item => url.includes(item)
        )
      ) {
        await route.abort();
      } else {
        await route.continue();
      }
    }
  );
}


// ============================================================================
// PAGE LOADING
// ============================================================================

async function loadPage(page, url) {

  console.log(
    `[explore] Loading: ${url}`
  );

  try {

    await page.goto(
      url,
      {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      }
    );

    await page.waitForTimeout(1000);

    return true;

  } catch (err) {

    console.error(
      `[explore] Failed to load ${url}:`,
      err.message
    );

    return false;
  }
}


// ============================================================================
// URL HELPERS
// ============================================================================

function resolveUrl(target, base) {

  try {
    return new URL(
      target,
      base
    ).href;
  } catch (_) {
    return '';
  }
}


function isSameOrigin(target, base) {

  try {

    return (
      new URL(target).origin ===
      new URL(base).origin
    );

  } catch (_) {

    return false;
  }
}


// ============================================================================
// HOMEPAGE FEATURE SELECTION
// ============================================================================

/**
 * The ONLY exploration LLM call.
 *
 * It selects major features from the homepage.
 *
 * It does NOT decide individual clicks/fills.
 */
async function discoverFlows(elements) {

  const compactElements =
    elements.map(element => ({
      elementId:
        element.elementId,

      tag:
        element.tag,

      text:
        element.text || '',

      label:
        element.label || '',

      role:
        element.role || '',

      href:
        element.href || '',

      ariaLabel:
        element.ariaLabel || ''
    }));


  const prompt = `
You are selecting major functional areas of an unfamiliar web application
for automated testing.

HOMEPAGE INTERACTIVE ELEMENTS:

${JSON.stringify(
  compactElements,
  null,
  2
)}

Select at most ${MAX_FLOWS} MAJOR FEATURES.

IMPORTANT:

- Select only major top-level application features.
- Prefer large functional sections represented by cards, major links,
  navigation items, or clearly grouped controls.
- Do NOT select every sub-feature.
- If a major section contains many smaller features, select the major
  section itself and let the automation explore the selected section.
- Do NOT select footer links.
- Ignore advertisements.
- Ignore social media.
- Ignore privacy/terms links.
- Ignore external websites.
- Do not invent functionality.
- Use only observed element IDs and hrefs.
- Prefer different functional areas rather than multiple links leading
  to essentially the same thing.
- Return no more than ${MAX_FLOWS} features.

For each selected feature return:

{
  "name": "short feature name",
  "description": "what this major feature appears to provide",
  "entryElementId": number,
  "entryUrl": "observed href or empty string"
}

Return ONLY valid JSON.
`.trim();


  try {

    const response =
      await callLLM(
        prompt,
        {
          maxTokens: 700,
          temperature: 0.1
        }
      );


    let parsed;

    try {

      parsed =
        JSON.parse(response);

    } catch (_) {

      const start =
        response.indexOf('[');

      const end =
        response.lastIndexOf(']');

      if (
        start === -1 ||
        end <= start
      ) {
        throw new Error(
          'Invalid feature selection JSON'
        );
      }

      parsed =
        JSON.parse(
          response.slice(
            start,
            end + 1
          )
        );
    }


    if (!Array.isArray(parsed)) {
      return [];
    }


    const valid =
      parsed
        .filter(
          feature =>
            feature &&
            typeof feature.name === 'string'
        )
        .map(feature => {

          const element =
            elements.find(
              el =>
                el.elementId ===
                feature.entryElementId
            );

          const href =
            element
              ? element.href || ''
              : feature.entryUrl || '';

          return {

            name:
              feature.name.trim(),

            description:
              typeof feature.description === 'string'
                ? feature.description.trim()
                : '',

            entryElementId:
              Number.isInteger(
                feature.entryElementId
              )
                ? feature.entryElementId
                : null,

            entryUrl:
              resolveUrl(
                href,
                HOME_URL
              )
          };
        })
        .filter(
          feature =>
            feature.name &&
            (
              feature.entryUrl ||
              feature.entryElementId !== null
            )
        )
        .filter(
          feature =>
            !feature.entryUrl ||
            isSameOrigin(
              feature.entryUrl,
              HOME_URL
            )
        )
        .slice(
          0,
          MAX_FLOWS
        );


    console.log(
      `[explore] Selected ${valid.length} major feature(s):`,
      valid.map(
        feature => feature.name
      )
    );

    return valid;

  } catch (err) {

    console.error(
      '[explore] Feature selection failed:',
      err.message
    );

    return [];
  }
}


// ============================================================================
// DOM EXTRACTION
// ============================================================================

async function extractElements(page) {

  try {

    const raw =
      await getDOMElements(page);

    return preprocessDOM(raw);

  } catch (err) {

    console.error(
      '[explore] DOM extraction failed:',
      err.message
    );

    return [];
  }
}


// ============================================================================
// FIND ELEMENT
// ============================================================================

function findElement(elements, selector) {

  return elements.find(
    element =>
      element.selector === selector
  );
}


// ============================================================================
// PAGE-LEVEL FEATURE FILTERING
// ============================================================================

async function askLLMForSubFeatures(elements, flowName = '') {
  if (!Array.isArray(elements) || !elements.length) {
    return [];
  }

  const compactElements = elements.map(element => ({
    elementId: element.elementId,
    tag: (element.tag || '').toUpperCase(),
    type: element.inputType || '',
    text: element.text || '',
    label: element.label || '',
    placeholder: element.placeholder || '',
    name: element.name || '',
    role: element.role || '',
    href: element.href || '',
    ariaLabel: element.ariaLabel || '',
    id: element.id || '',
    selector: element.selector || ''
  }));

  const prompt = `
You are selecting a small, meaningful subset of controls for a single web-page feature.
Select at most 2 representative sub-features from the observed page DOM.
Do not traverse unrelated sections or every widget on the page.
Keep this website-independent and use only the observed elements.

Current feature: ${flowName || 'current application area'}

DOM:
${JSON.stringify(compactElements, null, 2)}

Choose only the meaningful interaction groups that best demonstrate the feature.
Return ONLY valid JSON in this shape:
[
  { "kind": "form", "elementIds": [1, 2, 3] },
  { "kind": "checkbox", "elementIds": [4, 5] }
]
Allowed kinds: "form", "checkbox", "radio", "select", "button".
Use up to 2 groups total.
If no meaningful control group is present, return []
`.trim();

  try {
    const response = await callLLM(prompt, {
      maxTokens: 500,
      temperature: 0.1
    });

    const parsed = JSON.parse(response);

    if (!Array.isArray(parsed)) {
      return [];
    }

    const normalized = parsed
      .filter(item => item && typeof item.kind === 'string')
      .map(item => ({
        kind: item.kind.toLowerCase(),
        elements: Array.isArray(item.elementIds)
          ? elements.filter(element => item.elementIds.includes(element.elementId))
          : []
      }))
      .filter(item => ['form', 'checkbox', 'radio', 'select', 'button'].includes(item.kind) && item.elements.length)
      .slice(0, 2);

    return normalized;
  } catch (err) {
    return [];
  }
}

function selectRelevantSubFeatures(elements, maxSubFeatures = 2) {
  if (!Array.isArray(elements) || !elements.length) {
    return [];
  }

  const selected = [];

  const textInputs = elements.filter(element => {
    const tag = (element.tag || '').toUpperCase();
    const type = (element.inputType || '').toLowerCase();
    const labelText = [
      element.label,
      element.placeholder,
      element.name,
      element.ariaLabel,
      element.id,
      element.text
    ].filter(Boolean).join(' ').toLowerCase();

    if (tag === 'TEXTAREA') {
      return true;
    }

    if (tag !== 'INPUT') {
      return false;
    }

    if (['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'reset', 'color', 'range'].includes(type)) {
      return false;
    }

    return labelText.includes('name') ||
      labelText.includes('email') ||
      labelText.includes('phone') ||
      labelText.includes('address') ||
      labelText.includes('search') ||
      labelText.includes('subject') ||
      labelText.includes('message') ||
      labelText.includes('city') ||
      labelText.includes('country') ||
      labelText.includes('date') ||
      labelText.includes('code') ||
      labelText.includes('text');
  });

  if (textInputs.length) {
    selected.push({
      kind: 'form',
      elements: textInputs.slice(0, 3)
    });
  }

  const checkboxInputs = elements.filter(element => (element.inputType || '').toLowerCase() === 'checkbox');
  if (checkboxInputs.length && selected.length < maxSubFeatures) {
    selected.push({
      kind: 'checkbox',
      elements: checkboxInputs.slice(0, 2)
    });
  }

  if (!checkboxInputs.length && selected.length < maxSubFeatures) {
    const radioInputs = elements.filter(element => (element.inputType || '').toLowerCase() === 'radio');
    if (radioInputs.length) {
      selected.push({
        kind: 'radio',
        elements: radioInputs.slice(0, 2)
      });
    }
  }

  if (selected.length < maxSubFeatures) {
    const selects = elements.filter(element => (element.tag || '').toUpperCase() === 'SELECT');
    if (selects.length) {
      selected.push({
        kind: 'select',
        elements: selects.slice(0, 1)
      });
    }
  }

  if (selected.length < maxSubFeatures) {
    const actionButtons = elements.filter(element => {
      const tag = (element.tag || '').toUpperCase();
      const role = (element.role || '').toLowerCase();
      const text = [
        element.text,
        element.label,
        element.ariaLabel,
        element.id
      ].filter(Boolean).join(' ').toLowerCase();

      const isButton = tag === 'BUTTON' || role === 'button' || (
        tag === 'INPUT' && ['submit', 'button'].includes((element.inputType || '').toLowerCase())
      );

      if (!isButton) {
        return false;
      }

      return text.includes('submit') || text.includes('save') || text.includes('search') || text.includes('login') || text.includes('register') || text.includes('continue') || text.includes('next');
    });

    if (actionButtons.length) {
      selected.push({
        kind: 'button',
        elements: actionButtons.slice(0, 1)
      });
    }
  }

  return selected.slice(0, maxSubFeatures);
}

function shouldCaptureScreenshot(action, step, captureEveryStep = false) {
  if (captureEveryStep) {
    return true;
  }

  if (action === false) {
    return step === 0;
  }

  if (!action || action === 'done') {
    return false;
  }

  return step === 0 || ['click', 'fill', 'navigate'].includes(action);
}

// ============================================================================
// SAFE DEFAULT VALUES
// ============================================================================

function getSafeValue(element) {

  const combined =
    [
      element.label,
      element.placeholder,
      element.name,
      element.ariaLabel,
      element.id
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();


  if (
    combined.includes('email')
  ) {
    return 'test@example.com';
  }


  if (
    combined.includes('password')
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
    combined.includes('first') &&
    combined.includes('name')
  ) {
    return 'Test';
  }


  if (
    combined.includes('last') &&
    combined.includes('name')
  ) {
    return 'User';
  }


  if (
    combined.includes('name')
  ) {
    return 'Test User';
  }


  if (
    combined.includes('address')
  ) {
    return '123 Test Street';
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
    combined.includes('search')
  ) {
    return 'test search';
  }


  return 'Test Input';
}


// ============================================================================
// LOG ACTION
// ============================================================================

async function performAndLog(
  page,
  flow,
  state,
  action,
  element,
  screenshotPrefix
) {

  const before =
    await getPageMeta(page);


  let success = true;
  let error = '';


  let screenshotBefore = '';

  if (CAPTURE_SCREENSHOTS) {

    screenshotBefore =
      await captureScreenshot(
        page,
        `${state.globalStep}_before_${screenshotPrefix}.png`
      );
  }


  try {

    if (
      action === 'fill'
    ) {

      const locator =
        page.locator(
          element.selector
        ).first();

      await locator.fill(
        getSafeValue(element),
        {
          timeout: 8000
        }
      );

    } else if (
      action === 'check'
    ) {

      const locator =
        page.locator(
          element.selector
        ).first();

      await locator.check({
        timeout: 8000
      });

    } else if (
      action === 'select'
    ) {

      const locator =
        page.locator(
          element.selector
        ).first();

      const options =
        await locator.locator('option').all();

      if (options.length > 0) {

        await locator.selectOption({
          index: 0
        });
      }

    } else if (
      action === 'click'
    ) {

      const locator =
        page.locator(
          element.selector
        ).first();

      await locator.scrollIntoViewIfNeeded({
        timeout: 8000
      });

      await locator.click({
        timeout: 8000
      });

      await page.waitForTimeout(500);
    }

  } catch (err) {

    success = false;

    error =
      err.message || String(err);

    console.warn(
      `[explore] ${action} failed on ${element.selector}:`,
      error
    );
  }


  const after =
    await getPageMeta(page);


  let screenshotAfter = '';

  if (CAPTURE_SCREENSHOTS) {

    screenshotAfter =
      await captureScreenshot(
        page,
        `${state.globalStep}_after_${screenshotPrefix}.png`
      );
  }


  storeStep(
    state.memoryLog,
    {

      step:
        state.globalStep,

      flow_name:
        flow.name,

      planning_cycle:
        state.flowActionCount,

      from_url:
        before.url,

      from_title:
        before.title,

      action,

      target:
        element.text ||
        element.label ||
        element.ariaLabel ||
        element.selector,

      target_element_details:
        element,

      value:
        action === 'fill'
          ? getSafeValue(element)
          : '',

      to_url:
        after.url,

      to_title:
        after.title,

      success,

      error,

      reason:
        'Deterministic Playwright interaction.',

      screenshot_before:
        screenshotBefore,

      screenshot_after:
        screenshotAfter,

      timestamp:
        new Date().toISOString()
    }
  );


  state.globalStep++;
  state.flowActionCount++;

  saveLog(
    state.memoryLog,
    MEMORY_LOG_PATH
  );


  return {
    success,
    before,
    after
  };
}


// ============================================================================
// DETERMINISTIC PAGE EXPLORATION
// ============================================================================

/**
 * Playwright explores the controls on the selected page.
 *
 * NO LLM CALL HERE.
 */
async function exploreCurrentPage(
  page,
  flow,
  state
) {

  console.log(
    `[explore] Deterministically exploring: ${page.url()}`
  );


  let elements =
    await extractElements(page);


  if (!elements.length) {
    return;
  }


  let groups =
    await askLLMForSubFeatures(
      elements,
      flow.name
    );

  if (!groups.length) {
    groups =
      selectRelevantSubFeatures(
        elements,
        2
      );
  }


  for (const group of groups) {

    if (
      state.flowActionCount >=
      MAX_ACTIONS_PER_PAGE
    ) {
      break;
    }

    const groupElements =
      Array.isArray(group.elements)
        ? group.elements
        : [];

    if (group.kind === 'form') {
      for (const element of groupElements) {
        if (
          state.flowActionCount >=
          MAX_ACTIONS_PER_PAGE
        ) {
          break;
        }

        await performAndLog(
          page,
          flow,
          state,
          'fill',
          element,
          'fill'
        );
      }
    }

    if (group.kind === 'checkbox') {
      for (const element of groupElements) {
        if (element.checked === true) {
          continue;
        }

        if (
          state.flowActionCount >=
          MAX_ACTIONS_PER_PAGE
        ) {
          break;
        }

        await performAndLog(
          page,
          flow,
          state,
          'check',
          element,
          'checkbox'
        );
      }
    }

    if (group.kind === 'radio') {
      const seen = new Set();

      for (const element of groupElements) {
        const radioGroup = element.name || element.id || element.selector;

        if (seen.has(radioGroup)) {
          continue;
        }

        seen.add(radioGroup);

        if (
          state.flowActionCount >=
          MAX_ACTIONS_PER_PAGE
        ) {
          break;
        }

        await performAndLog(
          page,
          flow,
          state,
          'click',
          element,
          'radio'
        );
      }
    }

    if (group.kind === 'select') {
      for (const element of groupElements) {
        if (
          state.flowActionCount >=
          MAX_ACTIONS_PER_PAGE
        ) {
          break;
        }

        await performAndLog(
          page,
          flow,
          state,
          'select',
          element,
          'select'
        );
      }
    }

    if (group.kind === 'button') {
      for (const element of groupElements) {
        if (
          state.flowActionCount >=
          MAX_ACTIONS_PER_PAGE
        ) {
          break;
        }

        await performAndLog(
          page,
          flow,
          state,
          'click',
          element,
          'button'
        );
      }
    }
  }
}


// ============================================================================
// EXPLORE SELECTED FLOW
// ============================================================================

async function exploreFlow(
  page,
  flow,
  memoryLog,
  state
) {

  console.log(
    `\n${'='.repeat(60)}`
  );

  console.log(
    `[explore] Feature ${state.flowNumber}: ${flow.name}`
  );

  console.log(
    `${'='.repeat(60)}`
  );


  let entryUrl =
    flow.entryUrl;


  if (!entryUrl) {

    console.warn(
      `[explore] No entry URL for ${flow.name}`
    );

    return;
  }


  if (
    !isSameOrigin(
      entryUrl,
      HOME_URL
    )
  ) {

    console.warn(
      `[explore] Skipping external feature: ${entryUrl}`
    );

    return;
  }


  const loaded =
    await loadPage(
      page,
      entryUrl
    );


  if (!loaded) {
    return;
  }


  const visitedPages =
    new Set();


  for (
    let pageNumber = 0;
    pageNumber < MAX_PAGES_PER_FLOW;
    pageNumber++
  ) {

    const currentUrl =
      page.url();


    if (
      visitedPages.has(currentUrl)
    ) {
      break;
    }


    visitedPages.add(currentUrl);


    state.flowActionCount = 0;


    await exploreCurrentPage(
      page,
      flow,
      state
    );


    /*
     * IMPORTANT:
     *
     * We deliberately do NOT recursively crawl every link/sub-feature.
     *
     * The LLM already selected the major feature.
     *
     * This prevents:
     *
     * Elements
     *   -> Text Box
     *   -> Checkbox
     *   -> Radio Button
     *   -> Web Tables
     *   -> Buttons
     *   -> Links
     *   -> Broken Links
     *   -> ...
     *
     * from becoming dozens of additional exploration branches.
     *
     * The selected feature itself is exercised instead.
     */

    break;
  }


  console.log(
    `[explore] Feature "${flow.name}" finished.`
  );
}


// ============================================================================
// CONTEXT
// ============================================================================

function buildAndSaveContext(memoryLog) {

  console.log(
    '\n[explore] Building structured context...'
  );


  const context =
    buildContext(
      memoryLog
    );


  fs.writeFileSync(
    CONTEXT_PATH,
    JSON.stringify(
      context,
      null,
      2
    ),
    'utf8'
  );


  console.log(
    `[explore] Context saved → ${CONTEXT_PATH}`
  );


  console.log(
    `[explore] Context contains ` +
    `${context.flows.length} flow(s), ` +
    `${context.website.pages.length} page(s).`
  );


  return context;
}


// ============================================================================
// MAIN
// ============================================================================

async function runExploration() {

  ensureDirectories();


  const memoryLog = [];


  clearLog(
    MEMORY_LOG_PATH
  );


  const browser =
    await chromium.launch({
      headless: false
    });


  const page =
    await browser.newPage();


  await page.setViewportSize({
    width: 1280,
    height: 900
  });


  await setupRequestBlocking(
    page
  );


  console.log(
    `\n[explore] Loading homepage: ${HOME_URL}`
  );


  const homeLoaded =
    await loadPage(
      page,
      HOME_URL
    );


  if (!homeLoaded) {

    await browser.close();
    return;
  }


  console.log(
    '[explore] Extracting homepage DOM...'
  );


  const homeElements =
    await extractElements(
      page
    );


  console.log(
    `[explore] Homepage elements found: ${homeElements.length}`
  );


  if (!homeElements.length) {

    console.error(
      '[explore] No useful homepage elements found.'
    );

    await browser.close();
    return;
  }


  // --------------------------------------------------------------------------
  // ONE LLM CALL.
  // --------------------------------------------------------------------------

  const flows =
    await discoverFlows(
      homeElements
    );


  if (!flows.length) {

    console.error(
      '[explore] No major features selected.'
    );

    await browser.close();
    return;
  }


  const state = {

    globalStep: 0,

    flowNumber: 0,

    flowActionCount: 0,

    memoryLog
  };


  // --------------------------------------------------------------------------
  // Explore ONLY selected features.
  // --------------------------------------------------------------------------

  for (
    const flow of flows
  ) {

    state.flowNumber++;


    await exploreFlow(
      page,
      flow,
      memoryLog,
      state
    );
  }


  console.log(
    '\n[explore] All selected features explored.'
  );


  console.log(
    `[explore] Total steps logged: ${memoryLog.length}`
  );


  const context =
    buildAndSaveContext(
      memoryLog
    );


  // --------------------------------------------------------------------------
  // Final LLM call: generate test cases.
  // --------------------------------------------------------------------------

  console.log(
    '\n[explore] Generating test cases from context...'
  );


  const testCases =
    await generateTestCases(
      context
    );


  console.log(
    `[explore] Generated ${testCases.length} test case(s).`
  );


  await browser.close();


  return {
    memoryLog,
    context,
    testCases
  };
}


// ============================================================================
// ERROR HANDLING
// ============================================================================

if (
  require.main === module
) {

  runExploration()
    .catch(err => {

      console.error(
        '[explore] Run failed:',
        err.message
      );

      process.exit(1);
    });
}


// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  runExploration,
  buildAndSaveContext,
  discoverFlows,
  shouldCaptureScreenshot,
  selectRelevantSubFeatures,
  askLLMForSubFeatures
};