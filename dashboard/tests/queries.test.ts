import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock('@supabase/supabase-js', () => mocks);
import { getRun, getSummaries } from '../src/lib/queries';
import { fixtureRuns, summary } from './fixtures';
beforeEach(() => { vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co'); vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'server-test-key'); });
afterEach(() => vi.unstubAllEnvs());
describe('Supabase data contract', () => {
  it('collects beyond Supabase default page limits using an ordered cursor', async () => {
    const rows = Array.from({ length: 1002 }, (_, i) => summary({ run_id: `run-${String(i).padStart(4, '0')}` }));
    const from = vi.fn(), order = vi.fn(), gt = vi.fn(), select = vi.fn(), limit = vi.fn();
    let cursor: string | undefined;
    const chain = { select, order, gt, limit, then: (resolve: (v: unknown) => void) => Promise.resolve({ data: rows.filter(r => !cursor || r.run_id > cursor).slice(0, 1000), error: null }).then(resolve) };
    from.mockImplementation(() => { cursor = undefined; return chain; }); select.mockReturnValue(chain); order.mockReturnValue(chain); limit.mockReturnValue(chain); gt.mockImplementation((_field, id) => { cursor = id; return chain; });
    mocks.createClient.mockReturnValue({ from });
    expect(await getSummaries()).toHaveLength(1002); expect(from).toHaveBeenCalledTimes(2); expect(order).toHaveBeenCalledWith('run_id'); expect(gt).toHaveBeenCalledWith('run_id', 'run-0999');
  });
  it('rejects incompatible summary rows instead of quietly displaying zeros', async () => {
    const chain: Record<string, unknown> = {}; chain.select = () => chain; chain.order = () => chain; chain.limit = () => Promise.resolve({ data: [{ run_id: 'legacy-incompatible' }], error: null });
    mocks.createClient.mockReturnValue({ from: () => chain }); await expect(getSummaries()).rejects.toThrow('shared contract');
  });
  it('does not expose raw database error messages or credentials', async () => {
    const chain: Record<string, unknown> = {}; chain.select = () => chain; chain.order = () => chain; chain.limit = () => Promise.resolve({ data: null, error: { code: '42501', message: 'sensitive error body' } });
    mocks.createClient.mockReturnValue({ from: () => chain }); await expect(getSummaries()).rejects.toThrow('42501'); await expect(getSummaries()).rejects.not.toThrow('sensitive');
  });
  it('uses an exact run ID and preserves original arrays', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: fixtureRuns[0], error: null }), eq = vi.fn().mockReturnValue({ maybeSingle });
    mocks.createClient.mockReturnValue({ from: () => ({ select: () => ({ eq }) }) });
    expect(await getRun('fixture-mobile-b')).toEqual(fixtureRuns[0]); expect(eq).toHaveBeenCalledWith('run_id', 'fixture-mobile-b');
  });
});
