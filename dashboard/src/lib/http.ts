import { NextResponse } from 'next/server';
import { AccessError, requireAccess } from './access';
export async function safeResponse(fn: () => Promise<unknown>) {
  try { await requireAccess(); return NextResponse.json(await fn(), { headers: { 'Cache-Control': 'private, no-store' } }); }
  catch (e) { const status = e instanceof AccessError ? 401 : 503; return NextResponse.json({ error: e instanceof Error ? e.message : 'Data is unavailable.' }, { status, headers: { 'Cache-Control': 'private, no-store' } }); }
}
