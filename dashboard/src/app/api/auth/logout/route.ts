import { NextResponse } from 'next/server';
import { authClient, requireAccess, authMode } from '@/lib/access';
import { sameOrigin } from '@/lib/origin';
export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 });
  try { await requireAccess(); if (authMode() === 'supabase') await (await authClient()).auth.signOut(); return NextResponse.json({ ok: true }); }
  catch { return NextResponse.json({ error: 'Not signed in.' }, { status: 401 }); }
}
