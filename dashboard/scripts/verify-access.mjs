import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
// A temporary production server tests signed-out behavior without team passwords.
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3001'], {
  env: { ...process.env, DASHBOARD_AUTH_MODE: 'supabase', SUPABASE_ANON_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
});
server.stdout.resume(); server.stderr.resume();
const base = 'http://127.0.0.1:3001';
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {
    try { const response = await fetch(base + '/login'); if (response.ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, 'Temporary hosted-mode server did not start.');
  for (const path of ['/api/overview', '/api/runs', '/api/runs/a-run', '/api/export', '/api/auth/session']) {
    const response = await fetch(base + path); assert.equal(response.status, 401, path + ' must require authentication');
  }
  const page = await fetch(base + '/runs/example?tab=cases&case=TC002', { redirect: 'manual' });
  assert.equal(page.status, 307);
  const login = new URL(page.headers.get('location'), base); assert.equal(login.pathname, '/login'); assert.equal(login.searchParams.get('next'), '/runs/example?tab=cases&case=TC002');
  const logout = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { origin: 'https://untrusted.example' } });
  assert.equal(logout.status, 403);
  console.log('Production access checks passed: five unauthenticated APIs blocked, shared page redirected with its URL preserved, cross-origin logout refused.');
} finally {
  server.kill();
  await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve); });
}
