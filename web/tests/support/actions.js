'use strict';

const { expect } = require('@playwright/test');

// ============================================================================
// runSteps(page, steps)
//
// Executes the JSON "steps" array produced by testGenerator.js against a
// live Playwright page. This lives outside tests/generated/ on purpose: the
// generated .spec.js files just call runSteps(page, steps) — all the
// action-specific logic (dialog lookahead, tab switching, select-option
// fallbacks, force-checking hidden checkboxes) is centralized here so
// regenerating scripts never has to regenerate this logic too.
//
// Supported actions (must match testGenerator.js's validActions):
//   navigate, click, fill, check, uncheck, select, hover,
//   acceptalert, dismissalert, switchtab
// ============================================================================

async function runSteps(page, steps, testInfo) {

  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('runSteps: no steps to execute');
  }

  // The "current" page can change when a step opens a new tab/window
  // (switchtab). Everything below reads/writes this local binding rather
  // than closing over the original `page` argument.
  let currentPage = page;

  for (let i = 0; i < steps.length; i++) {

    const step = steps[i];
    const next = steps[i + 1];

    if (!step || typeof step !== 'object') {
      continue;
    }

    const action = String(step.action || '').toLowerCase();

    // acceptalert/dismissalert steps are consumed as a *look-ahead* by the
    // action that triggers them (see below). If we land on one directly
    // (e.g. it's step 1, or the previous step didn't register a listener
    // for some reason) there's nothing left to pair it with — skip safely.
    if (action === 'acceptalert' || action === 'dismissalert') {
      continue;
    }

    const stepLabel =
      `Step ${step.stepNum ?? i + 1}: ${step.description || action}`;

    await test_step(stepLabel, async () => {

      // ----------------------------------------------------------------
      // Register a dialog handler BEFORE firing the action that triggers
      // it, when the next JSON step says a dialog should appear.
      // ----------------------------------------------------------------
      const nextAction = next ? String(next.action || '').toLowerCase() : '';

      if (nextAction === 'acceptalert' || nextAction === 'dismissalert') {
        currentPage.once('dialog', dialog => {
          if (nextAction === 'acceptalert') {
            dialog.accept().catch(() => {});
          } else {
            dialog.dismiss().catch(() => {});
          }
        });
      }

      currentPage = await runSingleStep(currentPage, step, action);
    });
  }

  return currentPage;
}

// Small wrapper so this file has no hard dependency on a specific Playwright
// test() context — test.step is imported lazily to avoid requiring the
// test runner in non-test contexts (e.g. if reused by a future CLI tool).
async function test_step(label, fn) {
  const { test } = require('@playwright/test');
  if (test && typeof test.step === 'function') {
    return test.step(label, fn);
  }
  return fn();
}

async function runSingleStep(page, step, action) {

  const selector = step.selector || '';
  const value = step.value || '';

  switch (action) {

    case 'navigate': {
      if (!value) {
        throw new Error('navigate step has no URL (step.value)');
      }
      await page.goto(value, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return page;
    }

    case 'click': {
      const locator = page.locator(selector).first();
      await locator.scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => {});
      await locator.click({ timeout: 10000 });
      return page;
    }

    case 'fill': {
      const locator = page.locator(selector).first();
      await locator.scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => {});
      await locator.fill(value, { timeout: 10000 });
      return page;
    }

    case 'check': {
      // Many sites (DemoQA included) visually hide the native
      // checkbox/radio behind a styled label. The input is still present
      // and interactable, just not painted with its own visible box, so
      // force:true is required — see domExtractor.js's isVisible() for
      // the matching detection logic on the exploration side.
      const locator = page.locator(selector).first();
      await locator.check({ timeout: 10000, force: true });
      return page;
    }

    case 'uncheck': {
      const locator = page.locator(selector).first();
      await locator.uncheck({ timeout: 10000, force: true });
      return page;
    }

    case 'select': {
      const locator = page.locator(selector).first();
      await selectOptionSmart(locator, value);
      return page;
    }

    case 'hover': {
      const locator = page.locator(selector).first();
      await locator.scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => {});
      await locator.hover({ timeout: 10000 });
      return page;
    }

    case 'switchtab': {
      const context = page.context();
      const newPage = await context.waitForEvent('page', { timeout: 10000 });
      await newPage.waitForLoadState('domcontentloaded').catch(() => {});
      return newPage;
    }

    default:
      throw new Error(`runSteps: unsupported action "${action}"`);
  }
}

// Tries value-as-option-value first, then as visible label, then as a
// case-insensitive label match. Generated test cases from testGenerator.js
// put the option's visible text OR value in "value" — we don't know which
// without trying.
async function selectOptionSmart(locator, value) {

  if (!value) {
    throw new Error('select step has no option value/label (step.value)');
  }

  try {
    await locator.selectOption(value, { timeout: 10000 });
    return;
  } catch (_) {
    // fall through
  }

  try {
    await locator.selectOption({ label: value }, { timeout: 10000 });
    return;
  } catch (_) {
    // fall through
  }

  const options = await locator.locator('option').allTextContents();
  const match = options.find(
    text => text.trim().toLowerCase() === value.trim().toLowerCase()
  );

  if (match) {
    await locator.selectOption({ label: match }, { timeout: 10000 });
    return;
  }

  throw new Error(`select step: no option matching "${value}" was found`);
}

// ============================================================================
// runAssertions(page, assertions, expectedResult)
//
// Executes the structured "assertions" array produced by testGenerator.js.
// If a test case ended up with zero valid assertions (older test_cases.json
// files generated before this field existed, or an LLM response that
// dropped them), we fall back to a best-effort parse of expected_result so
// old test_cases.json files still produce a meaningful check instead of a
// script that "passes" no matter what happened.
// ============================================================================

async function runAssertions(page, assertions, expectedResult) {

  const list = Array.isArray(assertions) ? assertions : [];

  if (list.length === 0) {
    await runFallbackAssertion(page, expectedResult);
    return;
  }

  for (const assertion of list) {
    await runSingleAssertion(page, assertion);
  }
}

async function runSingleAssertion(page, assertion) {

  const type = String(assertion.type || '').toLowerCase();
  const selector = assertion.selector || '';
  const locator = selector ? page.locator(selector).first() : null;

  switch (type) {

    case 'url': {
      if (assertion.equals) {
        await expect(page).toHaveURL(assertion.equals, { timeout: 10000 });
      } else if (assertion.contains) {
        await expect(page).toHaveURL(
          new RegExp(escapeRegex(assertion.contains)),
          { timeout: 10000 }
        );
      }
      return;
    }

    case 'title': {
      if (assertion.equals) {
        await expect(page).toHaveTitle(assertion.equals, { timeout: 10000 });
      } else if (assertion.contains) {
        await expect(page).toHaveTitle(
          new RegExp(escapeRegex(assertion.contains)),
          { timeout: 10000 }
        );
      }
      return;
    }

    case 'visible':
      await expect(locator).toBeVisible({ timeout: 10000 });
      return;

    case 'hidden':
      await expect(locator).toBeHidden({ timeout: 10000 });
      return;

    case 'text': {
      if (assertion.equals) {
        await expect(locator).toHaveText(assertion.equals, { timeout: 10000 });
      } else if (assertion.contains) {
        await expect(locator).toContainText(assertion.contains, { timeout: 10000 });
      }
      return;
    }

    case 'value':
      await expect(locator).toHaveValue(assertion.equals ?? '', { timeout: 10000 });
      return;

    case 'checked':
      await expect(locator).toBeChecked({ timeout: 10000 });
      return;

    case 'unchecked':
      await expect(locator).not.toBeChecked({ timeout: 10000 });
      return;

    case 'enabled':
      await expect(locator).toBeEnabled({ timeout: 10000 });
      return;

    case 'disabled':
      await expect(locator).toBeDisabled({ timeout: 10000 });
      return;

    case 'count':
      await expect(locator).toHaveCount(Number(assertion.equals), { timeout: 10000 });
      return;

    case 'attribute': {
      // HTML boolean attributes (required, disabled, readonly, checked,
      // multiple, selected, autofocus) render in the DOM as e.g.
      // required="" — never required="true". A generated assertion that
      // says { attribute: "required", equals: "true" } means "the
      // attribute is present", not "its value is literally the string
      // true", so we special-case that here instead of relying on every
      // generated test case (or LLM) to know the DOM quirk.
      const BOOLEAN_ATTRIBUTES = new Set([
        'required', 'disabled', 'readonly', 'checked',
        'multiple', 'selected', 'autofocus', 'hidden'
      ]);

      const attrName = String(assertion.attribute || '').toLowerCase();
      const equalsLower =
        typeof assertion.equals === 'string' ? assertion.equals.toLowerCase() : null;

      if (BOOLEAN_ATTRIBUTES.has(attrName) && (equalsLower === 'true' || equalsLower === 'false')) {
        if (equalsLower === 'true') {
          await expect(locator).toHaveAttribute(assertion.attribute, { timeout: 10000 });
        } else {
          await expect(locator).not.toHaveAttribute(assertion.attribute, { timeout: 10000 });
        }
      } else if (assertion.equals !== undefined) {
        await expect(locator).toHaveAttribute(assertion.attribute, String(assertion.equals), { timeout: 10000 });
      } else {
        await expect(locator).toHaveAttribute(assertion.attribute, { timeout: 10000 });
      }
      return;
    }

    default:
      // Should not happen — testGenerator.validateAssertions() already
      // filters unknown types out before this file ever sees them.
      console.warn(`[actions] Skipping unknown assertion type "${type}"`);
  }
}

// Best-effort fallback used only when a test case has no structured
// assertions at all. Recognizes the two phrasings testGenerator.js's own
// prompt/fallback tends to produce ("URL ... https://...", "remains
// https://..."); anything else is logged, not silently passed.
async function runFallbackAssertion(page, expectedResult) {

  const text = String(expectedResult || '');

  const urlMatch = text.match(/https?:\/\/[^\s".,)]+/);

  if (urlMatch) {
    await expect(page).toHaveURL(
      new RegExp(escapeRegex(urlMatch[0])),
      { timeout: 10000 }
    );
    return;
  }

  console.warn(
    '[actions] No structured assertions and no URL found in expected_result — ' +
    'this test case only verifies that its steps ran without throwing: ' +
    `"${text}"`
  );
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  runSteps,
  runAssertions
};
