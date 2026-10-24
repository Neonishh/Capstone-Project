import { NextResponse } from 'next/server';
import { sameOrigin } from '@/lib/origin';
import { authClient, authMode } from '@/lib/access';
import { z } from 'zod';
export async function POST(req: Request) {
  if (authMode() !== 'supabase') return NextResponse.json({ error: 'Sign-in is only used in hosted mode.' }, { status: 400 });
  if (!sameOrigin(req)) return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 });
  const parsed = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(500) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Enter a valid email and password.' }, { status: 400 });
  const allowed = (process.env.DASHBOARD_ALLOWED_EMAILS || '').split(',').map(x => x.trim().toLowerCase());
  if (!allowed.includes(parsed.data.email.toLowerCase())) return NextResponse.json({ error: 'This account is not authorized.' }, { status: 401 });
  try {
    const { error } = await (await authClient()).auth.signInWithPassword(parsed.data);
    return NextResponse.json(error ? { error: 'Sign-in failed. Check your credentials.' } : { ok: true }, { status: error ? 401 : 200 });
  } catch { return NextResponse.json({ error: 'Authentication is unavailable. Check server configuration.' }, { status: 503 }); }
}
