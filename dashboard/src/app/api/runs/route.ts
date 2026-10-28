import { safeResponse } from '@/lib/http';
import { getSummaries } from '@/lib/queries';
import { filterOptions, filterRows, parseFilters, sortRows } from '@/lib/filters';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) { return safeResponse(async () => {
  const all = await getSummaries(), filters = parseFilters(new URL(req.url).searchParams);
  const rows = sortRows(filterRows(all, filters), filters), page = Math.min(filters.page, Math.max(1, Math.ceil(rows.length / filters.size)));
  return { rows: rows.slice((page - 1) * filters.size, page * filters.size), total: rows.length, page, size: filters.size, options: filterOptions(all), fetchedAt: new Date().toISOString() };
}); }
