'use strict';

/**
 * scriptGenerator.js
 *
 * Responsibility:
 *
 *   Convert validated test_cases.json into executable Playwright spec
 *   files under tests/generated/.
 *
 * Pipeline:
 *
 *   Memory Log → Context Builder → Test Generator → JSON Test Cases
 *       ↓
 *   Script Generator (this file)
 *       ↓
 *   tests/generated/<flow>.spec.js
 *       ↓
 *   Playwright (via runTests.js)
 *
 * Each generated file is intentionally short: it imports the shared
 * runSteps/runAssertions helpers from tests/support/actions.js and just
 * feeds them the JSON data for each test case. All the action-specific
 * logic (dialog handling, select-option fallbacks, force-checking hidden
 * checkboxes, tab switching) lives in that one shared, hand-written file —
 * not duplicated into every generated spec — so regenerating scripts after
 * a new exploration run can never regenerate a bug into that logic.
 */

const fs = require('fs');
const path = require('path');

const TEST_CASES_PATH =
  path.join(__dirname, '..', 'logs', 'test_cases.json');

const GENERATED_DIR =
  path.join(__dirname, '..', 'tests', 'generated');

// Relative path from tests/generated/<file>.spec.js to tests/support/actions.js
const ACTIONS_IMPORT_PATH = '../support/actions';

// Relative path from tests/generated/<file>.spec.js to tests/support/fixtures.js
// (a thin wrapper around @playwright/test's `test` that auto-blocks known
// ad/tracker domains — see that file for why).
const FIXTURES_IMPORT_PATH = '../support/fixtures';


// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

/**
 * generateScripts(testCases, outDir)
 *
 * @param {Array} [testCases] - defaults to loading logs/test_cases.json
 * @param {string} [outDir]   - defaults to tests/generated/
 * @returns {{ files: string[], skipped: Array<{id: string, reason: string}> }}
 */
function generateScripts(testCases, outDir = GENERATED_DIR) {

  const cases =
    Array.isArray(testCases)
      ? testCases
      : loadTestCases();

  if (!Array.isArray(cases) || cases.length === 0) {
    console.warn('[scriptGenerator] No test cases to convert.');
    return { files: [], skipped: [] };
  }

  clearGeneratedDir(outDir);
  fs.mkdirSync(outDir, { recursive: true });

  const { valid, skipped } = partitionValid(cases);

  const byFlow = groupByFlow(valid);

  const files = [];

  for (const [flowName, flowCases] of byFlow.entries()) {

    const fileName = `${slugify(flowName)}.spec.js`;
    const filePath = path.join(outDir, fileName);

    const source = renderSpecFile(flowName, flowCases);

    fs.writeFileSync(filePath, source, 'utf8');
    files.push(filePath);

    console.log(
      `[scriptGenerator] ${flowCases.length} test case(s) for "${flowName}" → ${fileName}`
    );
  }

  if (skipped.length) {
    console.warn(
      `[scriptGenerator] Skipped ${skipped.length} test case(s):\n` +
      skipped.map(s => `  - ${s.id}: ${s.reason}`).join('\n')
    );
  }

  const indexPath = writeIndex(outDir, byFlow);
  files.push(indexPath);

  console.log(
    `[scriptGenerator] Generated ${files.length} file(s) in ${outDir}`
  );

  return { files, skipped };
}


// ============================================================================
// LOAD
// ============================================================================

function loadTestCases() {

  if (!fs.existsSync(TEST_CASES_PATH)) {
    console.error(`[scriptGenerator] ${TEST_CASES_PATH} does not exist.`);
    return [];
  }

  try {
    const raw = fs.readFileSync(TEST_CASES_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error(`[scriptGenerator] Failed to read/parse ${TEST_CASES_PATH}:`, err.message);
    return [];
  }
}


// ============================================================================
// VALIDATION (defense in depth — testGenerator.js already validates, but
// this file must never emit a .spec.js that can't even be parsed by Node)
// ============================================================================

const KNOWN_ACTIONS = new Set([
  'navigate', 'click', 'fill', 'check', 'uncheck',
  'select', 'hover', 'acceptalert', 'dismissalert', 'switchtab'
]);

const ACTIONS_WITHOUT_SELECTOR = new Set([
  'navigate', 'acceptalert', 'dismissalert', 'switchtab'
]);

function partitionValid(cases) {

  const valid = [];
  const skipped = [];

  cases.forEach((testCase, index) => {

    const id = testCase && testCase.id ? testCase.id : `#${index}`;

    if (!testCase || typeof testCase !== 'object') {
      skipped.push({ id, reason: 'not an object' });
      return;
    }

    if (!Array.isArray(testCase.steps) || testCase.steps.length === 0) {
      skipped.push({ id, reason: 'no steps' });
      return;
    }

    for (const step of testCase.steps) {

      const action = String(step && step.action || '').toLowerCase();

      if (!KNOWN_ACTIONS.has(action)) {
        skipped.push({ id, reason: `unknown action "${step && step.action}"` });
        return;
      }

      if (
        !ACTIONS_WITHOUT_SELECTOR.has(action) &&
        (!step.selector || typeof step.selector !== 'string')
      ) {
        skipped.push({ id, reason: `"${action}" step missing a selector` });
        return;
      }
    }

    valid.push(testCase);
  });

  return { valid, skipped };
}


// ============================================================================
// GROUPING
// ============================================================================

function groupByFlow(cases) {

  const map = new Map();

  for (const testCase of cases) {

    const flowName = testCase.flow || 'Unspecified Flow';

    if (!map.has(flowName)) {
      map.set(flowName, []);
    }

    map.get(flowName).push(testCase);
  }

  return map;
}


// ============================================================================
// RENDER ONE SPEC FILE
// ============================================================================

function renderSpecFile(flowName, flowCases) {

  const testBlocks = flowCases.map(renderTestBlock).join('\n\n');

  return `'use strict';

// AUTO-GENERATED by scriptGenerator.js from logs/test_cases.json.
// Do not hand-edit — regenerate instead (npm run generate:scripts), or
// your edits will be overwritten on the next run.
//
// Flow: ${flowName}

const { test } = require('${FIXTURES_IMPORT_PATH}');
const { runSteps, runAssertions } = require('${ACTIONS_IMPORT_PATH}');

test.describe(${JSON.stringify(flowName)}, () => {

${testBlocks}

});
`;
}

function renderTestBlock(testCase) {

  const title = `${testCase.id} [${testCase.type}] - ${testCase.objective}`;

  const stepsLiteral = toLiteral(testCase.steps, 4);
  const assertionsLiteral = toLiteral(testCase.assertions || [], 4);
  const expectedResultLiteral = JSON.stringify(testCase.expected_result || '');

  return `  test(${JSON.stringify(title)}, async ({ page }, testInfo) => {

    const steps = ${stepsLiteral};

    const assertions = ${assertionsLiteral};

    const currentPage = await runSteps(page, steps, testInfo);

    await runAssertions(currentPage, assertions, ${expectedResultLiteral});
  });`;
}

// Pretty-prints a JS value as an indented object/array literal (not just
// JSON.stringify) so generated files are readable/diffable in code review.
function toLiteral(value, indent) {
  const json = JSON.stringify(value, null, 2);
  const pad = ' '.repeat(indent);
  return json.split('\n').join('\n' + pad).trimStart();
}


// ============================================================================
// INDEX / MANIFEST
// ============================================================================

// Small JSON manifest mapping generated files back to flow + test case IDs,
// so runTests.js (and humans) can cross-reference a Playwright result back
// to the original test_cases.json entry without re-parsing spec source.
function writeIndex(outDir, byFlow) {

  const manifest = {};

  for (const [flowName, flowCases] of byFlow.entries()) {
    manifest[flowName] = {
      file: `${slugify(flowName)}.spec.js`,
      testCaseIds: flowCases.map(tc => tc.id)
    };
  }

  const indexPath = path.join(outDir, 'manifest.json');

  fs.writeFileSync(indexPath, JSON.stringify(manifest, null, 2), 'utf8');

  return indexPath;
}


// ============================================================================
// HELPERS
// ============================================================================

function clearGeneratedDir(outDir) {

  if (!fs.existsSync(outDir)) {
    return;
  }

  for (const entry of fs.readdirSync(outDir)) {
    if (entry.endsWith('.spec.js') || entry === 'manifest.json') {
      fs.unlinkSync(path.join(outDir, entry));
    }
  }
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'flow';
}


// ============================================================================
// CLI
// ============================================================================

if (require.main === module) {
  generateScripts();
}


// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  generateScripts
};
