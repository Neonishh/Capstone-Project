import { z } from 'zod';
import { rate, stoppedEarly } from './metrics';
import type { Summary } from './types';
const text = z.string().trim().max(180).catch('').default('');
const date = z.string().refine(s => !s || /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s).catch('').default('');
export const filterSchema = z.object({
  platform: z.enum(['', 'web', 'mobile']).catch('').default(''),
  arch: z.preprocess(v => typeof v === 'string' ? v.toUpperCase() : v, z.enum(['', 'A', 'B']).catch('').default('')),
  app: text, cmp: text, model: text, q: text, from: date, to: date,
  state: z.enum(['', 'completed', 'incomplete']).catch('').default(''), reason: text,
  early: z.enum(['', 'true']).catch('').default(''),
  sort: z.enum(['date_desc', 'date_asc', 'generated_desc', 'executed_desc', 'rate_desc']).catch('date_desc').default('date_desc'),
  page: z.coerce.number().int().min(1).max(1000000).catch(1).default(1),
  size: z.coerce.number().pipe(z.union([z.literal(10), z.literal(25), z.literal(50)])).catch(25).default(25)
});
export type Filters = z.infer<typeof filterSchema>;
export function parseFilters(params: URLSearchParams) { return filterSchema.parse(Object.fromEntries(params)); }
export function filterRows(rows: Summary[], f: Filters) {
  return rows.filter(r => (!f.platform || r.platform === f.platform) && (!f.arch || r.architecture === f.arch)
    && (!f.app || r.app_id === f.app) && (!f.cmp || r.comparison_id === f.cmp)
    && (!f.model || r.model === f.model) && (!f.state || r.execution_state === f.state)
    && (!f.reason || (f.reason === '__unknown' ? r.exploration_stop_reason === null : r.exploration_stop_reason === f.reason))
    && (!f.q || r.run_id.toLowerCase().includes(f.q.toLowerCase()))
    && (!f.from || Date.parse(r.created_at) >= Date.parse(`${f.from}T00:00:00Z`))
    && (!f.to || Date.parse(r.created_at) < Date.parse(`${f.to}T00:00:00Z`) + 86400000)
    && (!f.early || stoppedEarly(r)));
}
export function sortRows(rows: Summary[], f: Filters) {
  return [...rows].sort((a, b) => {
    const value = f.sort === 'generated_desc' ? b.generated - a.generated : f.sort === 'executed_desc' ? b.executed - a.executed
      : f.sort === 'rate_desc' ? (rate(b.passed, b.executed) ?? -1) - (rate(a.passed, a.executed) ?? -1)
      : (f.sort === 'date_asc' ? 1 : -1) * (Date.parse(a.created_at) - Date.parse(b.created_at));
    return value || a.run_id.localeCompare(b.run_id);
  });
}
export function filterOptions(rows: Summary[]) {
  const unique = (key: keyof Summary) => [...new Set(rows.map(r => r[key]).filter((v): v is string => typeof v === 'string' && !!v))].sort();
  return { apps: unique('app_id'), comparisons: unique('comparison_id'), models: unique('model'), reasons: unique('exploration_stop_reason') };
}
export function csv(rows: Summary[]) {
  const columns: (keyof Summary)[] = ['run_id', 'platform', 'architecture', 'app_id', 'comparison_id', 'created_at', 'execution_state', 'exploration_stop_reason', 'exploration_complete', 'model', 'generated', 'executed', 'passed', 'failed', 'timed_out', 'skipped', 'flaky'];
  const escape = (value: unknown) => { const s = value === null || value === undefined ? '' : String(value); const safe = /^[=+@\-\t\r]/.test(s) ? `'${s}` : s; return `"${safe.replaceAll('"', '""')}"`; };
  return '\uFEFF' + [columns.join(','), ...rows.map(r => columns.map(k => escape(r[k])).join(','))].join('\r\n');
}
