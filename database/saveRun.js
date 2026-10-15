'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const aliases = { expected: 'passed', unexpected: 'failed', timedOut: 'timed_out' };
const statuses = new Set(['passed', 'failed', 'skipped', 'timed_out', 'flaky']);

function normalizeResults(results) {
  if (!Array.isArray(results)) throw new Error('execution_results must be an array');
  const ids = new Set();
  return results.map(r => {
    const status = aliases[r.status] || r.status;
    const duration = Number(r.duration_ms ?? r.durationMs ?? 0);
    if (!r.id || ids.has(r.id) || !statuses.has(status) || !Number.isFinite(duration) || duration < 0) {
      throw new Error('Results require unique test IDs, supported statuses and nonnegative durations');
    }
    ids.add(r.id);
    return { id: r.id, status, duration_ms: duration, error: r.error ?? null,
      original_status: r.original_status || r.status, attachments: r.attachments || [] };
  });
}

function validate(run) {
  for (const key of ['run_id','app_id','comparison_id','created_at']) {
    if (typeof run[key] !== 'string' || !run[key].trim()) throw new Error(`Missing ${key}`);
  }
  if (!['web','mobile'].includes(run.platform) || !['A','B'].includes(run.architecture)) throw new Error('Invalid platform/architecture');
  if (!['completed','incomplete'].includes(run.execution_state)) throw new Error('Invalid execution_state');
  if (Number.isNaN(Date.parse(run.created_at))) throw new Error('Invalid created_at');
  if (!Array.isArray(run.memory_log) || !Array.isArray(run.test_cases)) throw new Error('Logs/cases must be arrays');
  const ids = run.test_cases.map(t => t.id);
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new Error('Test cases require unique string IDs');
  const normalized = normalizeResults(run.execution_results);
  if (normalized.some(r => !ids.includes(r.id))) throw new Error('Result ID not found in test cases');
  if (run.execution_state === 'completed' && (ids.length === 0 || normalized.length !== ids.length)) throw new Error('Completed runs must have a result for every case');
  const { owner, ...data } = run; // omit legacy owner from queued bundles
  return { ...data, execution_results: normalized };
}

async function uploadRun(run, env = process.env, fetchImpl = fetch) {
  run = validate(run);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing Supabase configuration');
  const url = new URL(env.SUPABASE_URL);
  if (url.protocol !== 'https:') throw new Error('SUPABASE_URL must use HTTPS');
  const response = await fetchImpl(`${url.origin}/rest/v1/runs?on_conflict=run_id`, {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(run)
  });
  if (!response.ok) throw new Error(`Supabase HTTP ${response.status}; check configuration/schema`);
}

async function saveRunToDb(run, { directory = path.join(__dirname, 'local'), env = process.env, fetchImpl } = {}) {
  run = validate(run);
  fs.mkdirSync(directory, { recursive: true });
  const name = crypto.createHash('sha256').update(run.run_id).digest('hex');
  const file = path.join(directory, `${name}.json`);
  const record = { run, pending: true };
  const write = () => { const temp = `${file}.${crypto.randomUUID()}.tmp`; fs.writeFileSync(temp, JSON.stringify(record)); fs.renameSync(temp, file); };
  write();
  if (env.DB_UPLOAD_ENABLED !== 'true') return { file, uploaded: false, reason: 'Upload disabled' };
  try { await uploadRun(run, env, fetchImpl); record.pending = false; write(); return { file, uploaded: true }; }
  catch (error) { return { file, uploaded: false, reason: error.message }; }
}

module.exports = { normalizeResults, validate, uploadRun, saveRunToDb };
