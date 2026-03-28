/**
 * explore.js
 * 
 * Usage:
 *   node explore.js <target_url>
 *   node explore.js https://practice.expandtesting.com
 *
 * Environment variables:
 *   STUB_LLM=true      — run without real LLM (for Day 1/2 testing)
 *   MAX_STEPS=10       — override exploration depth (default 10)
 *   OPENAI_API_KEY=... — required when STUB_LLM is not set
 */

'use strict';

const { chromium } = require('playwright');
const path = require('path');

const { getDOMElements, getPageMeta } = require('./src/domExtractor');
const { preprocessDOM, buildExplorationPrompt } = require('./src/preprocess');
const { storeStep, saveLog } = require('./src/memoryLog');
const { callLLM, parseAction, executeAction } = require('./src/llmClient');
const { generateTestCases } = require('./src/testGenerator');

// ─── Config ───────────────────────────────────────────────────────────────────
const TARGET_URL  = process.argv[2] || 'https://practice.expandtesting.com';
const MAX_STEPS   = parseInt(process.env.MAX_STEPS, 10) || 10;
const STUB_LLM    = process.env.STUB_LLM === 'true';

const LOGS_DIR        = path.join(__dirname, 'logs');
const SCREENSHOTS_DIR = path.join(LOGS_DIR, 'screenshots');
const MEMORY_LOG_PATH = path.join(LOGS_DIR, 'memory_log.json');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * takeScreenshot(page, label)
 * Captures a screenshot and returns the relative path string.
 *
 * @param {import('playwright').Page} page
 * @param {string} label  e.g. '1_before_BUTTON'
 * @returns {Promise<string>}  relative path like 'logs/screenshots/1_before_BUTTON.png'
 */
async function takeScreenshot(page, label) {
  const filename = `${label}.png`;
  const fullPath = path.join(SCREENSHOTS_DIR, filename);
  try {
    await page.screenshot({ path: fullPath, fullPage: false });
  } catch (err) {
    console.warn(`[explore] Screenshot failed (${label}):`, err.message);
  }
  return `logs/screenshots/${filename}`;
}

/**
 * delay(ms)
 * Small sleep to allow page transitions to settle.
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log(' Web Exploration Pipeline — Project 101 (PES University)');
  console.log(`  Target : ${TARGET_URL}`);
  console.log(`  Max steps : ${MAX_STEPS}`);
  console.log(`  LLM mode : ${STUB_LLM ? 'STUB (no API call)' : 'LIVE'}`);
  console.log('═══════════════════════════════════════════════════════\n');

  // ── Ensure output folders exist ───────────────────────────────────────────
  const fs = require('fs');
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR,        { recursive: true });

  // ── Launch Playwright Chromium ────────────────────────────────────────────
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (compatible; PES-Capstone-Bot/1.0)',
  });
  const page = await context.newPage();

  const memoryLog = [];
  let stepCounter = 0;

  try {
    // ── Initial navigation ─────────────────────────────────────────────────
    console.log(`[explore] Navigating to ${TARGET_URL}...`);
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const { url: startUrl, title: startTitle } = await getPageMeta(page);
    console.log(`[explore] Page loaded: "${startTitle}" (${startUrl})\n`);

    // ─────────────────────────────────────────────────────────────────────────
    //  EXPLORATION LOOP  ( extended to MAX_STEPS with all break conditions)
    // ─────────────────────────────────────────────────────────────────────────
    while (stepCounter < MAX_STEPS) {
      console.log(`──────── Step ${stepCounter + 1} / ${MAX_STEPS} ────────`);

      // 1. Capture page meta BEFORE action
      const { url: fromUrl, title: fromTitle } = await getPageMeta(page);

      // 2. Extract DOM elements
      let rawElements;
      try {
        rawElements = await getDOMElements(page);
        console.log(`[explore] Extracted ${rawElements.length} raw elements`);
      } catch (domErr) {
        console.error('[explore] getDOMElements() failed:', domErr.message, '— skipping step');
        stepCounter++;
        continue;
      }

      // 3. Preprocess DOM 
      const elements = preprocessDOM(rawElements);
      console.log(`[explore] After preprocessing: ${elements.length} elements (capped at ${50})`);

      if (elements.length === 0) {
        console.warn('[explore] No interactable elements found — ending exploration');
        break;
      }

      // 4. Take BEFORE screenshot
      const screenshotBeforeLabel = `${stepCounter + 1}_before_${elements[0]?.tag || 'page'}`;
      const screenshotBefore = await takeScreenshot(page, screenshotBeforeLabel);

      // 5. Build prompt (Day 2 work)
      const prompt = buildExplorationPrompt(elements, memoryLog);

      // 6. Call LLM for next action decision  ← Navya's code handles this
      let llmResponse;
      try {
        llmResponse = await callLLM(prompt);
      } catch (llmErr) {
        console.error('[explore] callLLM() error:', llmErr.message);
        // Log the failed step and continue
        storeStep(memoryLog, {
          step: stepCounter,
          from_url: fromUrl,
          from_title: fromTitle,
          action: 'error',
          target: 'LLM_FAILURE',
          target_element_details: null,
          to_url: fromUrl,
          to_title: fromTitle,
          screenshot_before: screenshotBefore,
          screenshot_after: screenshotBefore,
          timestamp: new Date().toISOString(),
          error: llmErr.message,
        });
        stepCounter++;
        continue;
      }

      // 7. Parse action from LLM response  ← Navya's parseAction()
      const action = parseAction(llmResponse);
      console.log(`[explore] LLM action → ${action.action} | selector: "${action.selector}" | reason: ${action.reason}`);

      // 8. Break condition: LLM signals completion
      if (action.action === 'done') {
        console.log('[explore] LLM returned "done" — exploration complete');
        break;
      }

      // 9. Execute the action  ← Navya's executeAction()
      let executeError = null;
      try {
        await executeAction(page, action);
        await delay(800); // let page settle after action
      } catch (execErr) {
        console.error(`[explore] executeAction failed (step ${stepCounter + 1}):`, execErr.message);
        executeError = execErr.message;
        // Don't break — log the failure and continue to next step
      }

      // 10. Capture page meta AFTER action
      const { url: toUrl, title: toTitle } = await getPageMeta(page);

      // 11. Take AFTER screenshot
      const screenshotAfterLabel = `${stepCounter + 1}_after_${action.action}`;
      const screenshotAfter = await takeScreenshot(page, screenshotAfterLabel);

      // 12. Resolve target element details
      const targetElement = elements.find(el => el.elementId === action.elementId) || null;

      // 13. Store step in memory log (Day 1 work)
      storeStep(memoryLog, {
        step: stepCounter,
        from_url: fromUrl,
        from_title: fromTitle,
        action: action.action,
        target: targetElement ? targetElement.tag : (action.url || action.selector || 'unknown'),
        target_element_details: targetElement
          ? {
              elementId: targetElement.elementId,
              tag: targetElement.tag,
              text: targetElement.text,
              id: targetElement.id,
              class: targetElement.className,
              selector: targetElement.selector,
            }
          : null,
        to_url: toUrl,
        to_title: toTitle,
        screenshot_before: screenshotBefore,
        screenshot_after: screenshotAfter,
        timestamp: new Date().toISOString(),
        ...(executeError ? { error: executeError } : {}),
        ...(action.value ? { value: action.value } : {}),
      });

      console.log(`[explore] Step ${stepCounter + 1} logged | ${fromUrl} → ${toUrl}`);

      // 14. Break condition: loop detection (same URL 3 times in a row)
      if (memoryLog.length >= 3) {
        const last3 = memoryLog.slice(-3).map(s => s.to_url);
        if (last3.every(u => u === toUrl)) {
          console.warn('[explore] Loop detected (same URL 3 consecutive steps) — ending exploration');
          break;
        }
      }

      stepCounter++;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  END OF LOOP
    // ─────────────────────────────────────────────────────────────────────────

    console.log(`\n[explore] Exploration complete — ${memoryLog.length} step(s) logged`);

    // Save memory log (Day 1 saveLog)
    saveLog(memoryLog, MEMORY_LOG_PATH);

    // Verify screenshot count
    const screenshots = fs.readdirSync(SCREENSHOTS_DIR).filter(f => f.endsWith('.png'));
    console.log(`[explore] Screenshots captured: ${screenshots.length} (expected ~${memoryLog.length * 2})`);

    // ── Day 3: Generate test cases from memory log ─────────────────────────
    if (memoryLog.length > 0) {
      console.log('\n[explore] Generating test cases from memory log...');
      await generateTestCases(memoryLog);
    }

  } catch (fatalErr) {
    console.error('\n[explore] FATAL ERROR:', fatalErr.message);
    console.error(fatalErr.stack);

    // Still save whatever was collected
    if (memoryLog.length > 0) {
      console.log('[explore] Saving partial memory log before exit...');
      saveLog(memoryLog, MEMORY_LOG_PATH);
    }

  } finally {
    await browser.close();
    console.log('\n[explore] Browser closed. Done.');

    // Final summary
    console.log('\n══════════════════════════════════════');
    console.log(' OUTPUT FILES:');
    console.log(`  • ${MEMORY_LOG_PATH}`);
    console.log(`  • ${path.join(LOGS_DIR, 'test_cases.json')}`);
    console.log(`  • ${SCREENSHOTS_DIR}/`);
    console.log('══════════════════════════════════════\n');
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
main().catch(err => {
  console.error('[explore] Unhandled error:', err.message);
  process.exit(1);
});
