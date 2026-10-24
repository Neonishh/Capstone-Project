import { NextResponse } from 'next/server';
import { requireAccess } from '@/lib/access';
export const dynamic = 'force-dynamic';
export async function GET() {
  try { return NextResponse.json(await requireAccess(), { headers: { 'Cache-Control': 'private, no-store' } }); }
  catch { return NextResponse.json({ error: 'Sign in with an authorized team account.' }, { status: 401, headers: { 'Cache-Control': 'private, no-store' } }); }
}
