import { NextResponse } from 'next/server';
import { requireAccess, AccessError } from '@/lib/access';
import { getRun } from '@/lib/queries';
export const dynamic = 'force-dynamic';
export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  try {
    await requireAccess(); const { runId } = await ctx.params;
    if (!runId || runId.length > 200) return NextResponse.json({ error: 'Invalid run ID.' }, { status: 400 });
    const run = await getRun(runId);
    return NextResponse.json(run ? { run, fetchedAt: new Date().toISOString() } : { error: 'Run not found.' }, { status: run ? 200 : 404, headers: { 'Cache-Control': 'private, no-store' } });
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : 'Unable to load run.' }, { status: e instanceof AccessError ? 401 : 503 }); }
}
