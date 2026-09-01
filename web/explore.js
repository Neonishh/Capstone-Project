'use strict';
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
  callLLM,
  parseJSONResponse
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
 * At least MIN_FLOWS major homepage features are requested from the LLM
 * (when the site actually has that many distinct functional areas), with
 * an upper bound of MAX_FLOWS so a very large site doesn't blow past
 * reasonable rate limits.
 */
const MIN_FLOWS =
  Number(process.env.MIN_FLOWS) || 5;

const MAX_FLOWS =
  Number(process.env.MAX_FLOWS) || 5;


/**
 * Maximum number of pages that can be entered while exploring
 * one selected feature.
 *
 * This prevents accidentally crawling an entire website.
 */
const MAX_PAGES_PER_FLOW =
  Number(process.env.MAX_PAGES_PER_FLOW) || 3;


/**
 * Maximum number of sub-feature link navigations performed per selected
 * homepage feature.
 */
const MAX_SUB_LINKS_PER_FLOW =
  Number(process.env.MAX_SUB_LINKS_PER_FLOW) || 2;


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

  const llmFeatures =
    await discoverFlowsViaLLM(elements);

  if (llmFeatures.length) {
    return llmFeatures;
  }

  console.warn(
    '[explore] LLM flow discovery returned nothing usable - ' +
    'using generic structural fallback (not website-specific).'
  );

  const fallbackFeatures =
    selectTopLevelFeatures(elements, MAX_FLOWS);

  return fallbackFeatures.map(feature => ({
    name: feature.name,
    description: `Top-level feature detected via structural fallback: ${feature.name}`,
    entryElementId: feature.elementId,
    entryUrl: resolveUrl(feature.href, HOME_URL)
  }));
}


/**
 * discoverFlowsViaLLM(elements)
 *
 * The PRIMARY path for major feature discovery. Always consults the LLM
 * with the raw, observed homepage elements - nothing here is specific to
 * any one website's category names.
 */
async function discoverFlowsViaLLM(elements) {


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

Select the MAJOR FEATURES of this application.

IMPORTANT:

- Identify every distinct major functional area/section you can find on
  this homepage - do not stop early.
- If the homepage has ${MIN_FLOWS} or more distinct functional areas,
  select at least ${MIN_FLOWS} of them.
- If the homepage genuinely has fewer than ${MIN_FLOWS} distinct areas,
  select all of them (do not invent extra ones to hit a count).
- Never select more than ${MAX_FLOWS} features total.
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

    if (valid.length < MIN_FLOWS) {
      console.warn(
        `[explore] LLM selected only ${valid.length} feature(s), ` +
        `fewer than MIN_FLOWS (${MIN_FLOWS}). This is expected if the ` +
        `homepage genuinely has fewer distinct sections; otherwise the ` +
        `LLM under-selected.`
      );
    }

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

async function askLLMForSubFeatures(elements, flowName = '', currentUrl = '') {
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
You are selecting which KINDS of controls are meaningful on this single web-page feature.
Do not enumerate individual elements - just say which kinds of interaction groups exist.
Keep this website-independent and use only the observed elements.

Current feature: ${flowName || 'current application area'}

DOM:
${JSON.stringify(compactElements, null, 2)}

Return ONLY valid JSON, an array of at most 2 kind strings, e.g.:
["link", "form"]
Allowed kinds: "link", "form", "checkbox", "radio", "select", "button".
- Use "link" for pages that are primarily navigation (e.g. a sidebar/menu
  of links leading to sub-pages, with no form/checkbox/etc on this page
  itself).
If no meaningful control group is present, return []
`.trim();

  try {
    const response = await callLLM(prompt, {
      maxTokens: 200,
      temperature: 0.1
    });

    let parsed;

    try {
      parsed = parseJSONResponse(response);
    } catch (parseErr) {
      console.warn(
        '[explore] Sub-feature LLM response was not valid JSON ' +
        '(even after stripping markdown fences) - using heuristic fallback:',
        parseErr.message
      );
      return [];
    }

    if (!Array.isArray(parsed)) {
      return [];
    }

    const allowedKinds = ['link', 'form', 'checkbox', 'radio', 'select', 'button'];

    const kinds = parsed
      .filter(item => typeof item === 'string')
      .map(item => item.toLowerCase())
      .filter(kind => allowedKinds.includes(kind))
      .slice(0, 2);

    // --------------------------------------------------------------------
    // IMPORTANT: completeness guarantee.
    //
    // The LLM only decided WHICH KINDS of interaction are meaningful on
    // this page (a semantic judgment). It does NOT enumerate individual
    // element ids - that would let the model silently omit fields (e.g.
    // returning only 2 of a practice form's 8 inputs). Instead, once a
    // kind is chosen, we deterministically collect EVERY matching
    // element of that kind on the page via Playwright's own DOM
    // extraction. This guarantees full field/checkbox/radio coverage
    // and keeps the LLM call itself small (fewer tokens).
    // --------------------------------------------------------------------

    const normalized = kinds
      .map(kind => ({
        kind,
        elements: collectAllElementsOfKind(elements, kind, 2, currentUrl)
      }))
      .filter(item => item.elements.length);

    return normalized;
  } catch (err) {
    console.warn(
      '[explore] Sub-feature LLM call failed - using heuristic fallback:',
      err.message
    );
    return [];
  }
}

function normalizeFeatureName(value) {
  return String(value || '').trim();
}


/**
 * collectAllElementsOfKind(elements, kind)
 *
 * Deterministically gathers every element on the current page matching a
 * given interaction kind. This is what guarantees that, e.g., ALL fields
 * of a practice form get filled rather than only whichever ones an LLM
 * happened to enumerate. Purely structural - no website-specific logic.
 */
function collectAllElementsOfKind(elements, kind, maxForHeterogeneousKinds = 2, currentUrl = '') {

  const NON_TEXT_INPUT_TYPES = new Set([
    'hidden', 'submit', 'button', 'checkbox', 'radio',
    'file', 'image', 'reset', 'color', 'range'
  ]);

  if (kind === 'form') {
    return elements.filter(element => {
      const tag = (element.tag || '').toUpperCase();
      const type = (element.inputType || '').toLowerCase();

      if (tag === 'TEXTAREA') {
        return true;
      }

      if (tag !== 'INPUT') {
        return false;
      }

      return !NON_TEXT_INPUT_TYPES.has(type);
    });
  }

  if (kind === 'checkbox') {
    return elements.filter(
      element => (element.inputType || '').toLowerCase() === 'checkbox'
    );
  }

  if (kind === 'radio') {
    return elements.filter(
      element => (element.inputType || '').toLowerCase() === 'radio'
    );
  }

  if (kind === 'select') {
    return elements.filter(
      element => (element.tag || '').toUpperCase() === 'SELECT'
    );
  }

  // --------------------------------------------------------------------
  // 'link' and 'button' are intentionally NOT exhaustive.
  //
  // A sidebar can have 8+ links (e.g. demoqa's Elements page: Text Box,
  // Check Box, Radio Button, Web Tables, Buttons, Links, ...). Clicking
  // the first one navigates away immediately, so a selector for the
  // 2nd/3rd/... link (captured from the OLD page) would no longer exist
  // on the new page and would simply fail. Capping here also keeps
  // exploration within "max N features per item" instead of trying to
  // visit every sidebar entry in one page visit.
  // --------------------------------------------------------------------

  if (kind === 'link') {
    const basePath = (() => {
      try {
        return new URL(currentUrl).pathname || '/';
      } catch (_) {
        return '/';
      }
    })();

    const normalizeHref = (href) => {
      const resolved = resolveUrl(href, currentUrl || HOME_URL);
      if (!resolved || !isSameOrigin(resolved, HOME_URL)) {
        return '';
      }

      try {
        const parsed = new URL(resolved);

        if (!parsed.pathname || parsed.pathname === '/') {
          return '';
        }

        if (parsed.pathname === basePath) {
          return '';
        }

        return parsed.href;
      } catch (_) {
        return '';
      }
    };

    const scoreUrl = (url, text) => {
      let score = 0;

      try {
        const current = new URL(currentUrl || HOME_URL);
        const next = new URL(url);

        const currentRoot = current.pathname.split('/').filter(Boolean)[0] || '';
        const nextRoot = next.pathname.split('/').filter(Boolean)[0] || '';

        if (currentRoot && currentRoot === nextRoot) {
          score += 3;
        }

        if (next.pathname.split('/').filter(Boolean).length > current.pathname.split('/').filter(Boolean).length) {
          score += 2;
        }
      } catch (_) {
        // Keep default score.
      }

      const lowerText = String(text || '').toLowerCase();
      if (lowerText.includes('home')) {
        score -= 10;
      }

      return score;
    };

    const seen = new Set();

    return elements
      .filter(element => {
        const tag = (element.tag || '').toUpperCase();
        const href = element.href || '';
        if (tag !== 'A' || !href || href.trim() === '#') {
          return false;
        }

        const resolved = normalizeHref(href);
        if (!resolved || seen.has(resolved)) {
          return false;
        }

        seen.add(resolved);
        return true;
      })
      .map(element => ({
        ...element,
        _resolvedHref: normalizeHref(element.href || ''),
        _score: scoreUrl(normalizeHref(element.href || ''), element.text || element.label || element.ariaLabel || '')
      }))
      .filter(element => element._resolvedHref)
      .sort((a, b) => b._score - a._score)
      .map(({ _resolvedHref, _score, ...element }) => element)
      .slice(0, maxForHeterogeneousKinds);
  }

  if (kind === 'button') {
    return elements
      .filter(element => {
        const tag = (element.tag || '').toUpperCase();
        const role = (element.role || '').toLowerCase();
        const type = (element.inputType || '').toLowerCase();

        return (
          tag === 'BUTTON' ||
          role === 'button' ||
          (tag === 'INPUT' && ['submit', 'button'].includes(type))
        );
      })
      .slice(0, maxForHeterogeneousKinds);
  }

  return [];
}

function selectTopLevelFeatures(elements, maxFeatures = 5) {
  if (!Array.isArray(elements) || !elements.length) {
    return [];
  }

  // Generic, website-independent boilerplate terms to exclude. These are
  // common site-chrome wording (footer/legal/account links) found across
  // many unrelated websites - NOT the name of any specific site's feature.
  const boilerplateTerms = [
    'privacy',
    'terms',
    'cookie',
    'sign in',
    'log in',
    'login',
    'sign up',
    'register',
    'contact us',
    'about us',
    'faq',
    'help',
    'sitemap',
    'careers'
  ];

  const seenHrefs = new Set();

  const topLevel = elements
    .filter(element => {
      const tag = (element.tag || '').toUpperCase();
      const text = normalizeFeatureName(element.text || element.label || element.ariaLabel || element.id || '');
      const href = (element.href || '').toLowerCase();

      if (tag !== 'A' && tag !== 'BUTTON' && tag !== 'DIV') {
        return false;
      }

      if (!text && !href) {
        return false;
      }

      const lowerText = text.toLowerCase();

      if (boilerplateTerms.some(term => lowerText.includes(term))) {
        return false;
      }

      const dedupeKey = href || lowerText;

      if (seenHrefs.has(dedupeKey)) {
        return false;
      }

      seenHrefs.add(dedupeKey);

      return true;
    })
    .map(element => ({
      name: normalizeFeatureName(element.text || element.label || element.ariaLabel || element.id || ''),
      href: element.href || '',
      elementId: element.elementId,
      selector: element.selector || ''
    }))
    .filter(item => item.name)
    .slice(0, maxFeatures);

  return topLevel;
}

function selectPageSubFeatures(elements, maxSubFeatures = 2) {
  if (!Array.isArray(elements) || !elements.length) {
    return [];
  }

  const groupings = [];

  const linkEntries = elements
    .filter(element => {
      const tag = (element.tag || '').toUpperCase();
      const text = normalizeFeatureName(element.text || element.label || element.ariaLabel || element.id || '');
      if (tag !== 'A') return false;
      return text.length > 0;
    })
    .map(element => ({
      name: normalizeFeatureName(element.text || element.label || element.ariaLabel || element.id || ''),
      href: element.href || '',
      elementId: element.elementId,
      selector: element.selector || ''
    }))
    .filter(item => item.name && !item.name.toLowerCase().includes('home'));

  for (const item of linkEntries.slice(0, maxSubFeatures)) {
    groupings.push({
      kind: 'link',
      name: item.name,
      href: item.href,
      elementId: item.elementId,
      selector: item.selector
    });
  }

  if (groupings.length < maxSubFeatures) {
    const formEntries = elements.filter(element => {
      const tag = (element.tag || '').toUpperCase();
      const type = (element.inputType || '').toLowerCase();
      if (tag !== 'INPUT') return false;
      if (['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'reset', 'color', 'range'].includes(type)) {
        return false;
      }
      return true;
    });

    for (const element of formEntries.slice(0, maxSubFeatures - groupings.length)) {
      const name = normalizeFeatureName(element.label || element.placeholder || element.name || element.ariaLabel || element.id || '');
      if (!name) continue;
      groupings.push({
        kind: 'form',
        name,
        elementId: element.elementId,
        selector: element.selector || ''
      });
    }
  }

  return groupings.slice(0, maxSubFeatures);
}

function selectRelevantSubFeatures(elements, maxSubFeatures = 2, currentUrl = '') {
  if (!Array.isArray(elements) || !elements.length) {
    return [];
  }

  // Try each kind in a reasonable priority order and take the first
  // maxSubFeatures kinds that actually have matching elements on this
  // page. Form/checkbox/radio/select are exhaustive within their kind
  // (guaranteeing full field coverage); link/button are capped inside
  // collectAllElementsOfKind since they're heterogeneous navigation/
  // action targets. 'link' is tried last so real functional widgets are
  // preferred over plain navigation when a page has both.
  const kindPriority = ['form', 'checkbox', 'radio', 'select', 'button', 'link'];

  const fallback = [];

  for (const kind of kindPriority) {

    if (fallback.length >= maxSubFeatures) {
      break;
    }

    const matches = collectAllElementsOfKind(elements, kind, 2, currentUrl);

    if (matches.length) {
      fallback.push({
        kind,
        elements: matches
      });
    }
  }

  return fallback;
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

// ============================================================================
// MEMORY LOG ELEMENT DETAILS
// ============================================================================

/**
 * buildTargetElementDetails(element)
 *
 * Trims a full extracted element down to the memory log's
 * target_element_details schema.
 *
 * Base fields match the schema exactly: elementId, tag, text, id, class,
 * selector.
 *
 * Three fields are added on top: inputType, required, placeholder. These
 * are necessary for evidence-based negative test generation downstream
 * (e.g. "this field is required" is the ONLY legitimate evidence for a
 * negative test case - without it, testGenerator can either never
 * produce a negative test, or have to invent one, which violates the
 * "don't invent evidence" rule).
 */
function buildTargetElementDetails(element) {

  if (!element) {
    return null;
  }

  return {

    elementId:
      element.elementId ?? null,

    tag:
      element.tag || '',

    text:
      element.text || '',

    id:
      element.id || null,

    class:
      element.className || '',

    selector:
      element.selector || '',

    inputType:
      element.inputType || '',

    required:
      element.required === true,

    placeholder:
      element.placeholder || ''
  };
}


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

      if (!element.selector) {
        const url =
          element.href
            ? resolveUrl(element.href, page.url())
            : '';

        if (url) {
          await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 15000
          });
        }

      } else {
        const locator =
          page.locator(
            element.selector
          ).first();

        try {
          await locator.scrollIntoViewIfNeeded({
            timeout: 8000
          });

          await locator.click({
            timeout: 8000,
            force: false
          });
        } catch (firstClickErr) {
          try {
            await locator.click({
              timeout: 10000,
              force: true
            });
          } catch (forcedClickErr) {
            await page.evaluate((selector) => {
              const candidate = document.querySelector(selector);
              if (candidate && candidate instanceof HTMLElement) {
                candidate.click();
                return true;
              }
              return false;
            }, element.selector);
          }
        }
      }

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
        buildTargetElementDetails(element),

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
      flow.name,
      page.url()
    );

  if (!groups.length) {
    groups =
      selectRelevantSubFeatures(
        elements,
        2,
        page.url()
      );
  }

  let navigatedToNewPage = false;


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

    if (group.kind === 'link') {
      if (state.flowLinkClicks >= MAX_SUB_LINKS_PER_FLOW) {
        continue;
      }

      const linkElements =
        groupElements.length
          ? groupElements
          : [group];

      for (const element of linkElements) {
        if (
          state.flowActionCount >=
          MAX_ACTIONS_PER_PAGE
        ) {
          break;
        }

        if (state.flowLinkClicks >= MAX_SUB_LINKS_PER_FLOW) {
          break;
        }

        const result = await performAndLog(
          page,
          flow,
          state,
          'click',
          element,
          'link'
        );

        if (result.success) {
          state.flowLinkClicks++;
        }

        if (result.success && result.after.url && result.after.url !== result.before.url) {
          navigatedToNewPage = true;
          break;
        }
      }

      if (navigatedToNewPage) {
        break;
      }
    }

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

  state.flowLinkClicks = 0;


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
     * We do NOT crawl every link on every page - askLLMForSubFeatures /
     * selectRelevantSubFeatures already cap each page to at most 2
     * meaningful interaction groups, so this never turns into:
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
     * But if one of those 1-2 selected interactions was a navigation
     * (e.g. clicking the "Text Box" sidebar link), the browser is now
     * sitting on a NEW page that has not been explored yet. Stopping
     * here would mean we only ever discover that a sub-page exists,
     * without ever exercising the actual controls on it (filling the
     * Text Box fields, checking the Check Box tree, etc).
     *
     * So the loop is allowed to continue: the next iteration checks
     * whether the current URL has already been visited (see
     * visitedPages above) and, if not, extracts and interacts with
     * THIS new page too - up to MAX_PAGES_PER_FLOW pages total for this
     * flow. If the interaction did NOT navigate anywhere (e.g. it was a
     * plain fill/check performed directly on the entry page), the URL
     * is unchanged on the next iteration and the loop exits naturally
     * via the visitedPages check above - so entry pages that ARE the
     * functional page (e.g. a practice form) still only run once.
     */
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
  selectTopLevelFeatures,
  selectPageSubFeatures,
  askLLMForSubFeatures
};