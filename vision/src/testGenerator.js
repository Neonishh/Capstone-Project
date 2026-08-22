'use strict';

/**
 * testGenerator.js — Vision Architecture test case generator.
 *
 * Takes a visual DOM, builds a prompt via visualDom.buildTestPrompt,
 * calls llm.callLLM, parses JSON array of test cases,
 * and saves results to storage/outputs/test_cases.json.
 */

const fs = require('fs');
const path = require('path');
const { callLLM, extractJSON } = require('./llm');
const { buildTestPrompt } = require('./visualDom');

const OUTPUT_DIR = path.join(__dirname, '..', 'storage', 'outputs');

// Workflow-style test cases (multi-step, with evidence fields) are long;
// a too-small budget truncates the JSON array mid-response.
const GENERATION_MAX_TOKENS =
  Number(process.env.GROQ_GEN_MAX_TOKENS) ||
  Math.max(Number(process.env.GROQ_MAX_TOKENS) || 700, 4500);

const GENERATION_ATTEMPTS = 2;

function saveTestCases(testCases, sourceFile) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outFile = path.join(
    OUTPUT_DIR,
    `test_cases_${path.basename(sourceFile || 'vision', path.extname(sourceFile || '.json'))}.json`
  );
  fs.writeFileSync(outFile, JSON.stringify(testCases, null, 2));
  return outFile;
}

async function generateTestCases(visualDOM) {
  if (!visualDOM || !Array.isArray(visualDOM.elements)) {
    throw new Error('generateTestCases: visualDOM with elements array required');
  }

  console.log(`[testGenerator] Building prompt from ${visualDOM.elements.length} elements...`);
  const prompt = buildTestPrompt(visualDOM);

  // Up to 2 attempts: truncated/unparseable LLM responses otherwise lose all
  // generated tests. Quota errors are not retried.
  let testCases = [];
  let llmError = null;

  for (let attempt = 1; attempt <= GENERATION_ATTEMPTS; attempt++) {
    let rawResponse;
    try {
      rawResponse = await callLLM(prompt, { maxTokens: GENERATION_MAX_TOKENS });
    } catch (err) {
      llmError = err;
      console.error(`[testGenerator] LLM call failed (attempt ${attempt}):`, err.message);
      if (err.status === 429 || (err.message || '').includes('quota')) break;
      continue;
    }

    let parsed = extractJSON(rawResponse);
    if (!Array.isArray(parsed)) {
      if (parsed && typeof parsed === 'object') parsed = [parsed];
      else parsed = [];
    }

    testCases = parsed.filter((tc) => tc.id && tc.objective && Array.isArray(tc.steps));
    if (testCases.length) break;

    llmError = new Error('no valid test cases parsed from LLM response');
    console.warn(
      `[testGenerator] Attempt ${attempt}: 0 valid test cases parsed${attempt < GENERATION_ATTEMPTS ? ' — retrying' : ''}.`
    );
  }

  if (!testCases.length) {
    console.warn('[testGenerator] No valid test cases parsed.');
    return {
      error: llmError && llmError.status ? 'llm_failed' : 'no_valid_test_cases',
      detail: llmError ? llmError.message : 'LLM returned no parseable test cases',
      test_cases: [],
    };
  }

  const savedPath = saveTestCases(testCases, visualDOM.saved_to);
  console.log(`[testGenerator] Saved ${testCases.length} test cases -> ${savedPath}`);

  return {
    architecture: 'B',
    run_id: visualDOM.run_id || null,
    source_url: visualDOM.source_url || null,
    element_count: visualDOM.elements.length,
    test_case_count: testCases.length,
    test_cases: testCases,
    saved_to: savedPath,
  };
}

module.exports = { generateTestCases };
