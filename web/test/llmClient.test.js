const test = require('node:test');
const assert = require('node:assert/strict');
// Unit tests do not make API calls or need a real credential.
process.env.GROQ_API_KEY ||= 'unit-test-placeholder';
const { parseJSONResponse, parseExplorationPlan } = require('../src/llmClient');

test('parses fenced JSON returned by the model', () => {
  assert.deepEqual(parseJSONResponse('```json\n["form"]\n```'), ['form']);
});

test('keeps select actions and their exact requested values', () => {
  const plan = parseExplorationPlan({ actions: [{ action: ' SELECT ', selector: ' #month ', value: '03', elementId: 7 }] });
  assert.equal(plan.actions[0].action, 'select');
  assert.equal(plan.actions[0].selector, '#month');
  assert.equal(plan.actions[0].value, '03');
});

test('rejects invalid model output and filters unsupported actions', () => {
  assert.throws(() => parseJSONResponse('not valid JSON'), /parse valid JSON/);
  assert.deepEqual(parseExplorationPlan([{ action: 'invented-action' }]), { actions: [] });
});
