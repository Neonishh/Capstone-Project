const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { saveRunToDb, validate } = require('./saveRun');
const run = { run_id: 'test-run', platform: 'web', architecture: 'A', app_id: 'demoqa', comparison_id: 'pair', created_at: '2026-10-14T00:00:00Z', execution_state: 'completed', memory_log: [], test_cases: [{ id: 'TC001' }], execution_results: [{ id: 'TC001', status: 'expected', durationMs: 5 }] };
test('normalizes results and rejects empty completed or mismatched runs', () => {
  assert.equal(validate(run).execution_results[0].status, 'passed');
  assert.throws(() => validate({ ...run, execution_results: [] }), /every case/);
  assert.throws(() => validate({ ...run, execution_results: [{ id: 'other', status: 'passed' }] }), /not found/);
});
test('offline save survives failed upload, replacement uses same file, success clears pending', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'capstone-db-'));
  try {
    const env = { DB_UPLOAD_ENABLED: 'true', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fake-test-key' };
    const first = await saveRunToDb(run, { directory, env, fetchImpl: async () => { throw new Error('offline'); } });
    assert.equal(first.uploaded, false);
    assert.equal(JSON.parse(fs.readFileSync(first.file)).pending, true);
    const second = await saveRunToDb(run, { directory, env, fetchImpl: async (url, options) => {
      assert.match(url, /on_conflict=run_id/);
      assert.equal(JSON.parse(options.body).execution_results[0].status, 'passed');
      return { ok: true };
    } });
    assert.equal(second.file, first.file);
    assert.equal(JSON.parse(fs.readFileSync(second.file)).pending, false);
    assert.equal(fs.readdirSync(directory).length, 1);
  } finally { fs.rmSync(directory, { recursive: true }); }
});
