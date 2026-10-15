'use strict';

/**
 * runTests.js
 *
 * Responsibility:
 *
 *   Full stage: test_cases.json → generated Playwright scripts → executed
 *   by Playwright → results summarized back against the original test
 *   case IDs.
 *
 * Pipeline:
 *
 *   Memory Log → Context Builder → Test Generator → JSON Test Cases
 *       ↓
 *   Script Generator → tests/generated/*.spec.js
 *       ↓
 *   Playwright (this file drives it)
 *       ↓
 *   logs/results.json, logs/playwright-report/, logs/run_summary.json
 *
 * Usage:
 *   node src/runTests.js
 *   npm run test:generated
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { readMetadata } = require('./runMetadata');
const { saveRunToDb } = require('../../database/saveRun');
let currentSummary = null;

const { generateScripts } = require('./scriptGenerator');

const ROOT_DIR = path.join(__dirname, '..');
const RESULTS_JSON_PATH = path.join(ROOT_DIR, 'logs', 'results.json');
const RUN_SUMMARY_PATH = path.join(ROOT_DIR, 'logs', 'run_summary.json');
const TEST_CASES_PATH = path.join(ROOT_DIR, 'logs', 'test_cases.json');
const HTML_REPORT_DIR = path.join(ROOT_DIR, 'logs', 'playwright-report');


// ============================================================================
// MAIN
// ============================================================================

async function main() {

  console.log('[runTests] Step 1/3 — generating Playwright scripts from test_cases.json ...');

  const { files, skipped } = generateScripts();

  if (files.length === 0) {
    console.error('[runTests] No scripts were generated. Nothing to run.');
    process.exitCode = 1;
    return;
  }

  console.log('\n[runTests] Step 2/3 — running Playwright ...\n');

  // Remove any stale results.json so a crashed run can't be mistaken for a
  // successful one when we read it back below.
  if (fs.existsSync(RESULTS_JSON_PATH)) {
    fs.unlinkSync(RESULTS_JSON_PATH);
  }

  const isWindows = process.platform === 'win32';

  const playwrightBin =
    path.join(ROOT_DIR, 'node_modules', '.bin', isWindows ? 'playwright.cmd' : 'playwright');

  const useLocalBin = fs.existsSync(playwrightBin);

  // IMPORTANT: on Windows, .cmd files can only be launched through the
  // shell (shell: true). When shell is true, Node does NOT auto-quote a
  // command that contains spaces (e.g. "E:\Capstone Project\...") — the
  // shell just splits on the space and tries to run "E:\Capstone" as the
  // program name. So we build one fully-quoted command STRING and pass it
  // as `command` with no separate `args`, rather than an args array.
  const commandString =
    useLocalBin
      ? `"${playwrightBin}" test`
      : (isWindows ? 'npx.cmd playwright test' : 'npx playwright test');

  const result = spawnSync(commandString, {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    shell: true
  });

  if (result.error) {
    console.error('[runTests] Failed to launch Playwright:', result.error.message);
    console.error(
      '[runTests] Make sure dependencies are installed: ' +
      'npm install -D @playwright/test && npx playwright install --with-deps'
    );
    process.exitCode = 1;
    return;
  }

  console.log('\n[runTests] Step 3/3 — summarizing results ...\n');

  const summary = buildSummary(skipped);
  currentSummary = summary;

  printSummary(summary);

  fs.writeFileSync(RUN_SUMMARY_PATH, JSON.stringify(summary, null, 2), 'utf8');

  console.log(`\n[runTests] Full HTML report → ${HTML_REPORT_DIR}/index.html`);
  console.log(`[runTests] Run summary JSON  → ${RUN_SUMMARY_PATH}`);
  console.log('[runTests] View the HTML report with: npx playwright show-report logs/playwright-report');

  // Exit non-zero if Playwright itself exited non-zero (test failures,
  // crash, etc.) so this script is usable as a CI gate.
  process.exitCode = result.status === null ? 1 : result.status;
}


// ============================================================================
// BUILD SUMMARY FROM logs/results.json
// ============================================================================

function buildSummary(skippedAtGenerationTime) {

  const testCases = loadJSON(TEST_CASES_PATH, []);
  const testCaseById = new Map(testCases.map(tc => [tc.id, tc]));

  const playwrightResults = loadJSON(RESULTS_JSON_PATH, null);

  if (!playwrightResults) {
    return {
      generatedAt: new Date().toISOString(),
      ranSuccessfully: false,
      error: `Could not read ${RESULTS_JSON_PATH} — Playwright may have crashed before writing results.`,
      skippedAtGeneration: skippedAtGenerationTime,
      results: []
    };
  }

  const results = [];

  for (const suite of flattenSuites(playwrightResults.suites || [])) {
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {

        const id = extractTestCaseId(spec.title);
        const testCase = testCaseById.get(id);

        const finalResult = (test.results || [])[test.results.length - 1] || {};

        results.push({
          id: id || null,
          title: spec.title,
          flow: testCase ? testCase.flow : (suite.title || null),
          type: testCase ? testCase.type : null,
          objective: testCase ? testCase.objective : null,
          status: test.status === 'unexpected' && finalResult.status === 'timedOut' ? 'timed_out' :
            (finalResult.status === 'interrupted' ? 'failed' : test.status),
          interrupted: finalResult.status === 'interrupted',
          durationMs: finalResult.duration || 0,
          retries: (test.results || []).length - 1,
          error: finalResult.error ? cleanErrorMessage(finalResult.error.message) : null,
          attachments: (finalResult.attachments || [])
            .map(a => a.path)
            .filter(Boolean)
        });
      }
    }
  }

  const totals = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    acc.total += 1;
    return acc;
  }, { total: 0 });

  return {
    generatedAt: new Date().toISOString(),
    ranSuccessfully: true,
    totals,
    skippedAtGeneration: skippedAtGenerationTime,
    results
  };
}

function flattenSuites(suites) {
  const out = [];
  for (const suite of suites) {
    out.push(suite);
    if (Array.isArray(suite.suites) && suite.suites.length) {
      out.push(...flattenSuites(suite.suites));
    }
  }
  return out;
}

// Titles are rendered by scriptGenerator.js as "TC001 [positive] - Objective..."
function extractTestCaseId(title) {
  const match = String(title || '').match(/^(TC\d+)/);
  return match ? match[1] : null;
}

// Playwright error messages include ANSI color codes and long stack-like
// locator logs; keep only the first couple of lines for the summary table,
// full detail is still in the HTML report/trace.
function cleanErrorMessage(message) {
  return String(message || '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .slice(0, 3)
    .join(' ')
    .trim();
}

function loadJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}


// ============================================================================
// PRINT SUMMARY TABLE
// ============================================================================

function printSummary(summary) {

  if (!summary.ranSuccessfully) {
    console.error(`[runTests] ${summary.error}`);
    return;
  }

  const statusIcon = status => ({
    passed: '✅',
    failed: '❌',
    timedOut: '⏱️ ',
    skipped: '⏭️ ',
    interrupted: '⚠️ '
  }[status] || '❔');

  console.log('ID      Status      Flow                      Duration   Objective');
  console.log('-'.repeat(100));

  for (const r of summary.results) {
    console.log(
      `${(r.id || '?').padEnd(7)} ` +
      `${statusIcon(r.status)} ${String(r.status).padEnd(10)} ` +
      `${(r.flow || '').slice(0, 24).padEnd(25)} ` +
      `${String(r.durationMs + 'ms').padEnd(10)} ` +
      `${(r.objective || r.title || '').slice(0, 60)}`
    );

    if (r.error) {
      console.log(`        → ${r.error.slice(0, 150)}`);
    }
  }

  console.log('-'.repeat(100));
  console.log(
    Object.entries(summary.totals)
      .filter(([key]) => key !== 'total')
      .map(([status, count]) => `${status}: ${count}`)
      .concat(`total: ${summary.totals.total}`)
      .join('  |  ')
  );

  if (summary.skippedAtGeneration && summary.skippedAtGeneration.length) {
    console.log(
      `\n[runTests] ${summary.skippedAtGeneration.length} test case(s) were never ` +
      'converted to a script (invalid steps) — see scriptGenerator output above.'
    );
  }
}


// ============================================================================
// CLI
// ============================================================================

if (require.main === module) {
  runWithStorage().catch(error => {
    console.error('[runTests]', error.message);
    process.exitCode = 1;
  });
}

async function runWithStorage() {
  const metadata = readMetadata();
  const runId = metadata.run_id;
  const createdAt = metadata.created_at;
  // Capture input data before execution; never read a stale prior summary.
  // Invalid input must not silently become an empty dataset in the shared DB.
  const cases = JSON.parse(fs.readFileSync(TEST_CASES_PATH, 'utf8'));
  const memory = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'logs', 'memory_log.json'), 'utf8'));
  try {
    await main();
  } finally {
    {
      const results = currentSummary?.results || [];
      const recorded = new Set(results.map(r => r.id));
      // Generation-skipped cases are explicit; absent/crashed execution stays incomplete.
      for (const skip of currentSummary?.skippedAtGeneration || []) {
        if (!recorded.has(skip.id)) {
          results.push({ id: skip.id, status: 'skipped', durationMs: 0, error: skip.reason });
          recorded.add(skip.id);
        }
      }
      try {
        const saved = await saveRunToDb({
          run_id: runId, created_at: createdAt, platform: 'web', architecture: 'A',
          app_id: metadata.app_id,
          comparison_id: metadata.comparison_id,
          execution_state: currentSummary?.ranSuccessfully && cases.length && results.length === cases.length && !results.some(r => r.interrupted) ? 'completed' : 'incomplete',
          memory_log: memory, test_cases: cases, execution_results: results
        });
        console.log(`[database] Run ${runId}: ${saved.uploaded ? 'uploaded' : 'saved locally; ' + saved.reason}`);
      } catch (error) {
        console.error('[database] Could not save run:', error.message);
        process.exitCode = 1;
      }
    }
  }
}

module.exports = {
  buildSummary
};
