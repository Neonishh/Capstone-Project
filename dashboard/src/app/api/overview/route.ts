import { safeResponse } from '@/lib/http';
import { getSummaries } from '@/lib/queries';
import { filterOptions, filterRows, parseFilters, sortRows } from '@/lib/filters';
import { aggregate, architectureTotals } from '@/lib/metrics';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) { return safeResponse(async () => {
  const all = await getSummaries(), filters = parseFilters(new URL(req.url).searchParams), rows = filterRows(all, filters);
  const reasons = Object.entries(rows.reduce<Record<string, number>>((acc, r) => { const reason = r.exploration_stop_reason || 'Not recorded'; acc[reason] = (acc[reason] || 0) + 1; return acc; }, {})).map(([reason, count]) => ({ reason, count }));
  return { totals: aggregate(rows), architectures: architectureTotals(rows), recent: sortRows(rows, filters).slice(0, 6), reasons, options: filterOptions(all), fetchedAt: new Date().toISOString() };
}); }
