const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRunArgs } = require('../src/runMetadata');

test('captures app/comparison without an owner and generates a fresh run ID', () => {
  const args = ['https://demoqa.com', '--app', 'demoqa', '--comparison', 'demoqa-01'];
  const first = parseRunArgs(args);
  assert.equal(first.app_id, 'demoqa');
  assert.equal(first.comparison_id, 'demoqa-01');
  assert.equal(first.ready, false);
  assert.equal('owner' in first, false);
  assert.notEqual(first.run_id, parseRunArgs(args).run_id);
});

test('rejects incomplete options, duplicate options and non-web URLs', () => {
  assert.throws(() => parseRunArgs(['https://demoqa.com']), /--app/);
  assert.throws(() => parseRunArgs(['https://demoqa.com', '--app']), /Usage/);
  assert.throws(() => parseRunArgs(['https://demoqa.com', '--app', 'x', '--app', 'y']), /Usage/);
  assert.throws(() => parseRunArgs(['file:///test', '--app', 'x', '--comparison', 'y']), /HTTP/);
});
