// Read-only smoke check. Never prints keys, cookies, or original dataset contents.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const base = process.env.DASHBOARD_TEST_URL || 'http://127.0.0.1:3000';
const overviewResponse = await fetch(base + '/api/overview');
const overview = await overviewResponse.json();
if (!overviewResponse.ok) throw new Error(overview.error || 'Overview failed');
const rowsResponse = await fetch(base + '/api/runs'); const rows = await rowsResponse.json();
if (!rowsResponse.ok) throw new Error(rows.error || 'Runs failed');
const csv = await fetch(base + '/api/export?size=10&page=2');
if (!csv.ok || !(await csv.text()).includes('run_id,platform,architecture')) throw new Error('CSV export failed');
console.log('Live database:', JSON.stringify({ totals: overview.totals, architectures: overview.architectures.map(a => ({ name: a.name, runs: a.runs })) }));
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base); await page.getByRole('heading', { name: 'Outcomes by architecture' }).waitFor();
  console.log('Computed font:', await page.locator('body').evaluate(e => getComputedStyle(e).fontFamily));
  await page.screenshot({ path: 'test-results/live-overview.png', fullPage: true });
  for (const platform of ['web', 'mobile']) {
    const row = rows.rows.find(r => r.platform === platform); if (!row) continue;
    const response = await fetch(base + '/api/runs/' + encodeURIComponent(row.run_id));
    const { run } = await response.json(); if (!response.ok || !run) throw new Error('Run detail failed');
    for (const tab of ['summary', 'cases', 'results', 'exploration', 'raw']) {
      await page.goto(base + '/runs/' + encodeURIComponent(row.run_id) + '?tab=' + tab);
      await page.locator('[role=tabpanel]').waitFor();
      if (await page.locator('.error-banner').count()) throw new Error('Run tab failed: ' + tab);
    }
    console.log('Verified live run:', JSON.stringify({ platform, id: run.run_id, cases: run.test_cases.length, results: run.execution_results.length }));
  }
  if (errors.length) throw new Error(errors.join('\n'));
  const env = fs.readFileSync('.env.local', 'utf8');
  const secrets = env.split(/\r?\n/).filter(l => /^SUPABASE_(SERVICE_ROLE_KEY|SECRET_KEY)=/.test(l)).map(l => l.slice(l.indexOf('=') + 1).replace(/^['"]|['"]$/g, '')).filter(Boolean);
  let files = 0;
  function scan(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const path = directory + '/' + entry.name;
      if (entry.isDirectory()) scan(path);
      else if (/\.(js|json|html|css)$/.test(entry.name)) { files++; const content = fs.readFileSync(path, 'utf8'); if (secrets.some(s => content.includes(s))) throw new Error('A server secret reached a browser artifact.'); }
    }
  }
  scan('.next/static');
  console.log('Browser artifact secret scan passed:', files, 'files.');
  console.log('Live API, CSV, web/mobile detail tabs, and browser runtime checks passed.');
} finally { await browser.close(); }
