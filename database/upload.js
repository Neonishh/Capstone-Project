'use strict';
// Upload existing pipeline output files. No npm dependencies needed (Node 18+).
const fs = require('node:fs');
const { saveRunToDb } = require('./saveRun');

async function main(args = process.argv.slice(2), save = saveRunToDb) {
  const options = {};
  const allowed = ['env', 'platform', 'architecture', 'app', 'comparison', 'run-id', 'memory', 'cases', 'results', 'state'];
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !allowed.includes(name) || !args[i + 1] || options[name]) throw new Error('Expected named options; see database/TEAM_SETUP.md');
    options[name] = args[i + 1];
  }
  for (const name of allowed.filter(n => !['env', 'state'].includes(n))) {
    if (!options[name]) throw new Error(`Missing --${name}`);
  }
  if (options.env) {
    for (const line of fs.readFileSync(options.env, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const index = line.indexOf('=');
      if (index < 1) throw new Error('Invalid .env line');
      const key = line.slice(0, index).trim();
      let value = line.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      process.env[key] ??= value;
    }
  }
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const results = read(options.results);
  const saved = await save({
    run_id: options['run-id'], created_at: new Date().toISOString(),
    platform: options.platform, architecture: options.architecture,
    app_id: options.app, comparison_id: options.comparison,
    execution_state: options.state || 'completed',
    memory_log: read(options.memory), test_cases: read(options.cases),
    execution_results: Array.isArray(results) ? results : results.results
  });
  console.log(saved.uploaded ? 'Uploaded successfully' : `Saved locally; ${saved.reason}`);
  console.log(`Run ID: ${options['run-id']}`);
  return saved;
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
