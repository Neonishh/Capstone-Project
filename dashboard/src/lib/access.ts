import 'server-only';
import { cookies, headers } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
export class AccessError extends Error { status = 401; }
export function authMode() { return process.env.DASHBOARD_AUTH_MODE || (process.env.NODE_ENV === 'development' ? 'local' : 'supabase'); }
export async function authClient() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) throw new AccessError('Hosted authentication is not configured.');
  const store = await cookies();
  return createServerClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    cookies: { getAll: () => store.getAll(), setAll: values => { try { for (const { name, value, options } of values) store.set(name, value, options); } catch { /* Server Components are read-only; session API persists refreshed cookies. */ } } }
  });
}
export async function requireAccess() {
  if (authMode() === 'local') {
    const host = (await headers()).get('host') || '';
    if (process.env.VERCEL || process.env.CF_PAGES || !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) throw new AccessError('Local mode is restricted to localhost. Configure team sign-in for hosting.');
    return { email: 'Local workspace', mode: 'local' };
  }
  const client = await authClient();
  const { data, error } = await client.auth.getUser();
  const allowed = (process.env.DASHBOARD_ALLOWED_EMAILS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  if (error || !data.user?.email || !allowed.includes(data.user.email.toLowerCase())) throw new AccessError('Sign in with an authorized team account.');
  return { email: data.user.email, mode: 'supabase' };
}
