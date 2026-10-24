import type { Summary, Run, CaseView, JsonObject } from './types';
export const outcomes = ['passed', 'failed', 'skipped', 'timed_out', 'flaky'] as const;
export const outcomeNames = { passed: 'Passed', failed: 'Failed', skipped: 'Skipped', timed_out: 'Timed out', flaky: 'Flaky' };
export const architectureNames = [
  { platform: 'web', architecture: 'A', name: 'Web A', description: 'Structure-based web' },
  { platform: 'web', architecture: 'B', name: 'Web B', description: 'Vision-based web' },
  { platform: 'mobile', architecture: 'A', name: 'Mobile A', description: 'Structure-based mobile' },
  { platform: 'mobile', architecture: 'B', name: 'Mobile B', description: 'Vision-based mobile' }
] as const;
export function rate(passed: number, executed: number): number | null { return executed > 0 ? passed / executed * 100 : null; }
export function rateLabel(passed: number, executed: number) { const r = rate(passed, executed); return r === null ? '—' : `${r.toFixed(1)}%`; }
export function stoppedEarly(r: Summary) {
  return r.exploration_complete === false || /budget|limit|error|failure|loop|partial/.test(r.exploration_stop_reason || '');
}
export function explorationLabel(r: Pick<Summary, 'exploration_complete' | 'exploration_stop_reason'>) {
  if (r.exploration_stop_reason) {
    const labels: Record<string, string> = { step_budget: 'Stopped at step budget', max_steps: 'Stopped at step budget', token_budget: 'Stopped at token budget', rate_limit: 'Rate limited', error: 'Exploration error', execution_error: 'Action error', loop_detected: 'Stopped at repeated actions', agent_done: 'Agent finished', partial_exploration: 'Partial exploration', llm_error: 'Model error', parse_error: 'Invalid model response', no_interactive_controls: 'No interactive controls' };
    return labels[r.exploration_stop_reason] || r.exploration_stop_reason.replaceAll('_', ' ');
  }
  return r.exploration_complete === true ? 'Agent finished' : r.exploration_complete === false ? 'Stopped early' : 'Not recorded';
}
export function resultCount(r: Summary) { return r.executed + r.skipped; }
export function executionLabel(r: Summary) {
  const recorded = resultCount(r);
  if (!recorded) return 'Not executed';
  if (recorded < r.generated) return `Partial (${recorded} / ${r.generated})`;
  return r.execution_state === 'completed' ? 'All cases ran' : 'All results recorded · run incomplete';
}
export function aggregate(rows: Summary[]) {
  const totals = { runs: rows.length, generated: 0, executed: 0, passed: 0, failed: 0, skipped: 0, timed_out: 0, flaky: 0, stopped: rows.filter(stoppedEarly).length };
  for (const r of rows) for (const k of ['generated', 'executed', ...outcomes] as const) totals[k] += r[k];
  // 'executed' and outcomes are distinct keys; the denominator is never an average of run rates.
  return { ...totals, passRate: rate(totals.passed, totals.executed) };
}
export function architectureTotals(rows: Summary[]) {
  return architectureNames.map(a => { const runs = rows.filter(r => r.platform === a.platform && r.architecture === a.architecture); return { ...a, ...aggregate(runs), latest: runs.map(r => r.created_at).sort().at(-1) || null }; });
}
const object = (v: unknown): JsonObject => v && typeof v === 'object' && !Array.isArray(v) ? v as JsonObject : {};
export function adaptCases(run: Run): CaseView[] {
  const results = new Map(run.execution_results.map(r => [String(r.id ?? r.test_case ?? r.test_case_id ?? ''), r]));
  return run.test_cases.map((c, i) => {
    const id = String(c.id ?? c.test_case_id ?? `case-${i + 1}`);
    return { id, objective: String(c.objective ?? c.title ?? c.name ?? id), category: c.category || c.type ? String(c.category ?? c.type) : null,
      setup: c.setup, steps: c.steps, expected: c.expected_result ?? c.expectedResult,
      assertions: c.verification ?? c.assertions, cleanup: c.cleanup, preconditions: c.preconditions,
      result: results.get(id) || null, raw: c };
  });
}
export function summaryFromRun(run: Run): Summary {
  const details = object(run.run_details); const llm = object(details.llm);
  const counts = { passed: 0, failed: 0, skipped: 0, timed_out: 0, flaky: 0 };
  for (const r of run.execution_results) if (outcomes.includes(r.status as typeof outcomes[number])) counts[r.status as keyof typeof counts]++;
  return { run_id: run.run_id, platform: run.platform, architecture: run.architecture, app_id: run.app_id, comparison_id: run.comparison_id, created_at: run.created_at, execution_state: run.execution_state,
    model: typeof llm.model === 'string' ? llm.model : null, exploration_complete: typeof details.exploration_complete === 'boolean' ? details.exploration_complete : null,
    exploration_stop_reason: typeof details.stop_reason === 'string' ? details.stop_reason : null,
    generated: run.test_cases.length, executed: run.execution_results.filter(r => r.status != null && r.status !== 'skipped').length, ...counts };
}
export function recordedTime(run: Run) {
  const values = run.execution_results.map(r => r.duration_ms).filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0);
  return { ms: values.reduce((a, b) => a + b, 0), recorded: values.length, total: run.execution_results.length };
}
export function comparisonConditions(a: Run, b: Run) {
  const da = object(a.run_details), db = object(b.run_details);
  const fields: [string, unknown, unknown][] = [
    ['App version', da.app_version ?? object(da.app).version, db.app_version ?? object(db.app).version],
    ['Device / emulator', da.device ?? da.environment, db.device ?? db.environment],
    ['Model', object(da.llm).model, object(db.llm).model],
    ['Exploration budget', da.limits, db.limits],
    ['Starting state', da.starting_state ?? da.preconditions, db.starting_state ?? db.preconditions],
    ['Input fixtures', da.fixtures, db.fixtures]
  ];
  function canonical(v: unknown): string {
    if (Array.isArray(v)) return JSON.stringify(v.map(canonical));
    if (v && typeof v === 'object') return JSON.stringify(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
    return JSON.stringify(v);
  }
  const known = (v: unknown) => v !== null && v !== undefined && v !== '' && (!(typeof v === 'object') || Object.keys(v).length > 0);
  return fields.map(([label, av, bv]) => ({ label, a: av ?? null, b: bv ?? null, state: !known(av) || !known(bv) ? 'Not recorded' : canonical(av) === canonical(bv) ? 'Same' : 'Different' }));
}
