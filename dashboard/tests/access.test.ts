import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
const mocks = vi.hoisted(() => ({ headers: vi.fn(), cookies: vi.fn(), createServerClient: vi.fn(), getUser: vi.fn() }));
vi.mock('next/headers', () => ({ headers: mocks.headers, cookies: mocks.cookies }));
vi.mock('@supabase/ssr', () => ({ createServerClient: mocks.createServerClient }));
import { requireAccess } from '../src/lib/access';
beforeEach(() => {
  vi.stubEnv('DASHBOARD_AUTH_MODE', 'local'); vi.stubEnv('VERCEL', ''); vi.stubEnv('CF_PAGES', '');
  mocks.headers.mockResolvedValue(new Headers({ host: '127.0.0.1:3000' })); mocks.cookies.mockResolvedValue({ getAll: () => [], set: vi.fn() });
  mocks.createServerClient.mockReturnValue({ auth: { getUser: mocks.getUser } });
});
afterEach(() => vi.unstubAllEnvs());
describe('access boundaries', () => {
  it('permits loopback-only local workspaces', async () => { expect(await requireAccess()).toEqual({ email: 'Local workspace', mode: 'local' }); });
  it('rejects external hosts and hosted environments in local mode', async () => {
    mocks.headers.mockResolvedValue(new Headers({ host: 'dashboard.example.com' })); await expect(requireAccess()).rejects.toThrow('localhost');
    mocks.headers.mockResolvedValue(new Headers({ host: 'localhost' })); vi.stubEnv('VERCEL', '1'); await expect(requireAccess()).rejects.toThrow('localhost');
  });
  it('fails closed when hosted auth configuration is absent', async () => { vi.stubEnv('DASHBOARD_AUTH_MODE', 'supabase'); vi.stubEnv('SUPABASE_ANON_KEY', ''); await expect(requireAccess()).rejects.toThrow('not configured'); });
  it('validates the Supabase user and the explicit team allowlist', async () => {
    vi.stubEnv('DASHBOARD_AUTH_MODE', 'supabase'); vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co'); vi.stubEnv('SUPABASE_ANON_KEY', 'public-test-key'); vi.stubEnv('DASHBOARD_ALLOWED_EMAILS', 'teammate@example.com');
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: null }); await expect(requireAccess()).rejects.toThrow('authorized');
    mocks.getUser.mockResolvedValue({ data: { user: { email: 'outsider@example.com' } }, error: null }); await expect(requireAccess()).rejects.toThrow('authorized');
    mocks.getUser.mockResolvedValue({ data: { user: { email: 'Teammate@example.com' } }, error: null }); expect(await requireAccess()).toMatchObject({ mode: 'supabase', email: 'Teammate@example.com' });
  });
});
