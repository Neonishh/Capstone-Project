import { NextResponse } from 'next/server';
import { requireAccess, AccessError } from '@/lib/access';
import { getRun, getSummaries } from '@/lib/queries';
import { csv, filterRows, parseFilters, sortRows } from '@/lib/filters';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  try {
    await requireAccess(); const params = new URL(req.url).searchParams, ids = params.getAll('id');
    if (ids.length > 20 || ids.some(id => id.length > 200)) return NextResponse.json({ error: 'Select at most 20 valid run IDs.' }, { status: 400 });
    let content: string, name: string, type: string;
    if (ids.length) {
      const runs = await Promise.all([...new Set(ids)].map(getRun));
      if (runs.some(r => !r)) return NextResponse.json({ error: 'A selected run no longer exists.' }, { status: 404 });
      content = JSON.stringify(runs.length === 1 ? runs[0] : runs, null, 2); name = 'selected-runs.json'; type = 'application/json';
    } else {
      const filters = parseFilters(params); content = csv(sortRows(filterRows(await getSummaries(), filters), filters)); name = 'capstone-run-summary.csv'; type = 'text/csv; charset=utf-8';
    }
    return new Response(content, { headers: { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'private, no-store' } });
  } catch (e) { return NextResponse.json({ error: e instanceof Error ? e.message : 'Export failed.' }, { status: e instanceof AccessError ? 401 : 503 }); }
}
