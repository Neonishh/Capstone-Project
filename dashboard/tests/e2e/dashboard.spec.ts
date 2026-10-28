import { expect, test } from '@playwright/test';
import { aggregate, architectureTotals } from '../../src/lib/metrics';
import { filterOptions, filterRows, parseFilters, sortRows } from '../../src/lib/filters';
import { fixtureRuns, fixtureSummaries } from '../fixtures';
test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', async route => {
    const u = new URL(route.request().url()), p = u.searchParams;
    let body: unknown;
    if (u.pathname === '/api/auth/session') body = { email: 'Local workspace', mode: 'local' };
    else if (u.pathname === '/api/overview') {
      const rows = filterRows(fixtureSummaries, parseFilters(p));
      body = { totals: aggregate(rows), architectures: architectureTotals(rows), recent: rows, reasons: [{ reason: 'step_budget', count: 1 }, { reason: 'Not recorded', count: 2 }], options: filterOptions(fixtureSummaries), fetchedAt: new Date().toISOString() };
    } else if (u.pathname === '/api/runs') {
      const f = parseFilters(p), rows = sortRows(filterRows(fixtureSummaries, f), f);
      body = { rows, total: rows.length, page: 1, size: f.size, options: filterOptions(fixtureSummaries), fetchedAt: new Date().toISOString() };
    } else if (u.pathname.startsWith('/api/runs/')) {
      const run = fixtureRuns.find(r => r.run_id === decodeURIComponent(u.pathname.split('/').at(-1)!));
      return route.fulfill({ status: run ? 200 : 404, json: run ? { run } : { error: 'Run not found.' } });
    } else if (u.pathname === '/api/export') return route.fulfill({ body: 'run_id,platform\r\nfixture-mobile-b,mobile', contentType: 'text/csv', headers: { 'Content-Disposition': 'attachment; filename="capstone-run-summary.csv"' } });
    else return route.continue();
    return route.fulfill({ json: body });
  });
});
test('overview displays evidence and honest missing architectures in both themes', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/'); await expect(page.getByRole('heading', { name: 'Evidence at a glance.' })).toBeVisible();
  await expect(page.getByText('No runs available', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View Web B runs' })).toHaveCount(0);
  await page.getByRole('button', { name: 'View as table', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Mobile B', exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Toggle color theme' }).click(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); window.scrollTo({ top: 0, behavior: 'instant' }); }); await page.screenshot({ path: `test-results/overview-${info.project.name}-dark.png`, fullPage: true });
  await page.getByRole('button', { name: 'Toggle color theme' }).click(); await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); window.scrollTo({ top: 0, behavior: 'instant' }); }); await page.screenshot({ path: `test-results/overview-${info.project.name}-light.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true); expect(errors).toEqual([]);
});
test('URL filters persist and row actions open the correct evidence', async ({ page }) => {
  await page.goto('/runs?platform=mobile');
  await page.getByRole('textbox', { name: 'Search run ID', exact: true }).fill('fixture-mobile-b'); await page.getByRole('textbox', { name: 'Search run ID', exact: true }).press('Enter');
  await expect(page).toHaveURL(/q=fixture-mobile-b/); await expect(page.getByRole('link', { name: 'Open run fixture-mobile-b', exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByRole('textbox', { name: 'Search run ID', exact: true })).toHaveValue('fixture-mobile-b');
  await page.getByRole('link', { name: 'Open run fixture-mobile-b', exact: true }).click(); await expect(page.getByRole('heading', { level: 1 })).toContainText('wdio-demo');
});
test('failed outcomes deep-link to a case and preserve case filtering', async ({ page }) => {
  await page.goto('/runs/fixture-mobile-b?tab=results');
  await expect(page.getByRole('heading', { name: 'Failure explanations' })).toBeVisible();
  await page.getByRole('button', { name: 'TC002', exact: true }).click(); await expect(page).toHaveURL(/tab=cases&case=TC002/);
  await expect(page.getByRole('heading', { name: 'Invalid email shows validation', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Filter case status' }).selectOption('passed'); await expect(page).toHaveURL(/caseStatus=passed/);
  await expect(page.getByRole('heading', { name: 'Login opens an editable email field', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /Raw data/ }).click(); await page.getByRole('textbox', { name: 'Search JSON' }).fill('invalid'); await expect(page.locator('.json-tree')).toContainText('Invalid email');
});
test('matching comparisons show conditions, counts, and denominators', async ({ page }) => {
  await page.goto('/compare?a=fixture-mobile-b&b=fixture-mobile-a');
  await expect(page.getByRole('heading', { name: 'Conditions check' })).toBeVisible();
  await expect(page.getByText('Not recorded', { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel('1 · Platform')).toHaveValue('mobile');
  await expect(page.getByLabel('4 · Run A')).toHaveValue('fixture-mobile-a');
  await expect(page.locator('.comparison-disclaimer')).toContainText('does not automatically mean a better architecture');
});
test('rejects incomparable runs and recovers from empty selections', async ({ page }) => {
  await page.goto('/compare?a=fixture-mobile-b&b=fixture-web-a'); await expect(page.locator('.error-banner[role=alert]')).toContainText('same platform');
  await page.goto('/runs?q=does-not-exist'); await expect(page.getByRole('heading', { name: 'No runs match these filters' })).toBeVisible();
});
test('retains prior results when a refresh fails', async ({ page }) => {
  await page.goto('/'); await expect(page.getByText('No runs available', { exact: true })).toBeVisible();
  await page.route('**/api/overview**', route => route.fulfill({ status: 503, json: { error: 'Database unavailable for this test.' } }));
  await page.getByRole('button', { name: 'Refresh data', exact: true }).click(); await expect(page.locator('.error-banner[role=alert]')).toContainText('Database unavailable'); await expect(page.getByRole('heading', { name: 'Outcomes by architecture' })).toBeVisible();
});
test('exports a download and mobile navigation closes after selection', async ({ page }, info) => {
  await page.goto('/exports'); const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download CSV', exact: true }).click(); expect((await download).suggestedFilename()).toBe('capstone-run-summary.csv');
  if (info.project.name === 'mobile') { await page.getByRole('button', { name: 'Open navigation' }).click(); await page.getByRole('dialog').getByRole('link', { name: 'Methodology' }).click(); await expect(page.getByRole('dialog')).toHaveCount(0); }
  else await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Methodology' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('numbers');
});
