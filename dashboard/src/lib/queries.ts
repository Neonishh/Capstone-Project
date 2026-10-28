import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Run, Summary } from './types';
const count = z.coerce.number().int().min(0);
const summarySchema = z.object({
  run_id: z.string(), platform: z.enum(['web', 'mobile']), architecture: z.enum(['A', 'B']),
  app_id: z.string(), comparison_id: z.string(), created_at: z.string(), execution_state: z.string(),
  model: z.string().nullable(), exploration_stop_reason: z.string().nullable(), exploration_complete: z.boolean().nullable(),
  generated: count, executed: count, passed: count, failed: count, skipped: count, timed_out: count, flaky: count
});
function db() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('Database configuration is missing. Add server credentials to dashboard/.env.local.');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (url, init) => fetch(url, { ...init, cache: 'no-store', signal: AbortSignal.timeout(15000) }) } });
}
export async function getSummaries(): Promise<Summary[]> {
  const client = db(); const rows: Summary[] = []; let last: string | null = null;
  while (true) {
    let query = client.from('run_summary').select('*').order('run_id').limit(1000);
    if (last) query = query.gt('run_id', last);
    const { data, error } = await query;
    if (error) throw new Error(`Database summaries are unavailable (${error.code || 'connection error'}). Retry or check the shared views.`);
    const parsed = z.array(summarySchema).safeParse(data);
    if (!parsed.success) throw new Error('Database summary fields do not match the shared contract. Check the dashboard setup guide.');
    rows.push(...parsed.data);
    if (parsed.data.length < 1000) return rows;
    last = parsed.data.at(-1)!.run_id;
  }
}
export async function getRun(id: string): Promise<Run | null> {
  const { data, error } = await db().from('runs').select('*').eq('run_id', id).maybeSingle();
  if (error) throw new Error(`Run details are unavailable (${error.code || 'connection error'}).`);
  if (!data) return null;
  if (!Array.isArray(data.memory_log) || !Array.isArray(data.test_cases) || !Array.isArray(data.execution_results)) throw new Error('This run has invalid dataset arrays.');
  return { ...data, run_details: data.run_details || {} } as Run;
}
