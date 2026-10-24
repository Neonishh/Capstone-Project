import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

// Refresh hosted sessions before Server Components render and preserve shared URLs.
// Data endpoints still perform their own user and team checks independently.
export async function proxy(request: NextRequest) {
  const mode = process.env.DASHBOARD_AUTH_MODE || (process.env.NODE_ENV === 'development' ? 'local' : 'supabase');
  if (mode === 'local') return NextResponse.next();
  let response = NextResponse.next({ request });
  const login = () => {
    const url = new URL('/login', request.url);
    url.searchParams.set('next', request.nextUrl.pathname + request.nextUrl.search);
    const redirect = NextResponse.redirect(url);
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    redirect.headers.set('Cache-Control', 'private, no-store');
    return redirect;
  };
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) return login();
  try {
    const client = createServerClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: values => {
          for (const { name, value } of values) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of values) response.cookies.set(name, value, options);
        }
      }
    });
    const { data, error } = await client.auth.getUser();
    const allowed = (process.env.DASHBOARD_ALLOWED_EMAILS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    if (error || !data.user?.email || !allowed.includes(data.user.email.toLowerCase())) return login();
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch { return login(); }
}
export const config = { matcher: ['/', '/runs/:path*', '/compare', '/exports', '/methodology'] };
