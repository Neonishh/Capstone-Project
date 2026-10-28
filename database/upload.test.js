const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('./upload');
const { validate } = require('./saveRun');

test('file uploader accepts summary results and keeps explicit comparison/run IDs', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'capstone-upload-'));
  try {
    const memory = path.join(directory, 'memory.json');
    const cases = path.join(directory, 'cases.json');
    const results = path.join(directory, 'results.json');
    fs.writeFileSync(memory, '[]');
    fs.writeFileSync(cases, JSON.stringify([{ id: 'TC001' }]));
    fs.writeFileSync(results, JSON.stringify({ results: [{ id: 'TC001', status: 'expected', durationMs: 2 }] }));
    await main(['--platform','web','--architecture','B','--app','demoqa','--comparison','demoqa-01','--run-id','demoqa-web-b-01','--memory',memory,'--cases',cases,'--results',results], async run => {
      const normalized = validate(run);
      assert.equal(normalized.execution_results[0].status, 'passed');
      assert.equal(run.run_id, 'demoqa-web-b-01');
      assert.equal(run.comparison_id, 'demoqa-01');
      assert.equal('owner' in run, false);
      return { uploaded: false, reason: 'test only' };
    });
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test('file uploader rejects missing identifiers before reading files', async () => {
  await assert.rejects(main(['--platform', 'web']), /Missing/);
});
