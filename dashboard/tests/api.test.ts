import { beforeEach, describe, expect, it, vi } from 'vitest';
const access = vi.hoisted(() => ({ requireAccess: vi.fn(), authMode: vi.fn(), authClient: vi.fn() }));
const query = vi.hoisted(() => ({ getSummaries: vi.fn(), getRun: vi.fn() }));
vi.mock('@/lib/access', () => ({ ...access, AccessError: class AccessError extends Error {} }));
vi.mock('@/lib/queries', () => query);
import { AccessError } from '../src/lib/access';
import { GET as overview } from '../src/app/api/overview/route';
import { GET as runs } from '../src/app/api/runs/route';
import { GET as details } from '../src/app/api/runs/[runId]/route';
import { GET as exportData } from '../src/app/api/export/route';
import { fixtureRuns, fixtureSummaries, summary } from './fixtures';
beforeEach(() => { vi.resetAllMocks(); access.requireAccess.mockResolvedValue({ mode: 'local' }); query.getSummaries.mockResolvedValue(fixtureSummaries); query.getRun.mockImplementation(async (id: string) => fixtureRuns.find(r => r.run_id === id) || null); });
describe('read-only data endpoints', () => {
  it('calculates overview totals before table pagination', async () => {
    query.getSummaries.mockResolvedValue(Array.from({ length: 31 }, (_, i) => summary({ run_id: `r${i}` })));
    const response = await overview(new Request('http://localhost/api/overview?size=10')); const body = await response.json();
    expect(body.totals.runs).toBe(31); expect(body.totals.executed).toBe(62); expect(body.recent.length).toBeLessThanOrEqual(10); expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it('filters all rows then clamps and paginates', async () => {
    query.getSummaries.mockResolvedValue(Array.from({ length: 31 }, (_, i) => summary({ run_id: `r${i}` })));
    const response = await runs(new Request('http://localhost/api/runs?platform=mobile&size=10&page=999'));
    expect(await response.json()).toMatchObject({ total: 31, page: 4, size: 10, rows: [{ run_id: expect.any(String) }] });
  });
  it('exports across pages and returns an original JSON record', async () => {
    query.getSummaries.mockResolvedValue(Array.from({ length: 31 }, (_, i) => summary({ run_id: `r${i}` })));
    const response = await exportData(new Request('http://localhost/api/export?size=10&page=2'));
    expect((await response.text()).split('\r\n')).toHaveLength(32);
    const record = await exportData(new Request('http://localhost/api/export?id=fixture-mobile-b'));
    expect(await record.json()).toEqual(fixtureRuns[0]); expect(record.headers.get('content-disposition')).toContain('attachment');
  });
  it('rejects excessive selection and missing records explicitly', async () => {
    expect((await exportData(new Request('http://localhost/api/export?' + Array.from({ length: 21 }, (_, i) => `id=r${i}`).join('&')))).status).toBe(400);
    expect((await exportData(new Request('http://localhost/api/export?id=missing'))).status).toBe(404);
    expect((await details(new Request('http://localhost/api/runs/missing'), { params: Promise.resolve({ runId: 'missing' }) })).status).toBe(404);
  });
  it('blocks every data endpoint before reading the database', async () => {
    access.requireAccess.mockRejectedValue(new AccessError('Sign in with an authorized team account.'));
    expect((await overview(new Request('http://localhost/api/overview'))).status).toBe(401);
    expect((await runs(new Request('http://localhost/api/runs'))).status).toBe(401);
    expect((await details(new Request('http://localhost/api/runs/test'), { params: Promise.resolve({ runId: 'test' }) })).status).toBe(401);
    expect((await exportData(new Request('http://localhost/api/export'))).status).toBe(401);
    expect(query.getSummaries).not.toHaveBeenCalled(); expect(query.getRun).not.toHaveBeenCalled();
  });
  it('returns a recoverable service error when Supabase is unavailable', async () => { query.getSummaries.mockRejectedValue(new Error('Database summaries are unavailable (connection error).')); expect((await runs(new Request('http://localhost/api/runs'))).status).toBe(503); });
});
