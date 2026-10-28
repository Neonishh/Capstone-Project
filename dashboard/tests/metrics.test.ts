import { describe, expect, it } from 'vitest';
import { adaptCases, aggregate, architectureTotals, comparisonConditions, executionLabel, rateLabel, recordedTime, summaryFromRun } from '../src/lib/metrics';
import { csv, filterRows, parseFilters, sortRows } from '../src/lib/filters';
import { sameOrigin } from '../src/lib/origin';
import { run, summary } from './fixtures';
describe('evidence metrics', () => {
  it('weights pass rates by executions and never averages run percentages', () => {
    const result = aggregate([summary({ passed: 1, executed: 1 }), summary({ passed: 0, executed: 9 })]);
    expect(result.passRate).toBe(10); expect(result.executed).toBe(10);
  });
  it('distinguishes no execution from zero passes', () => { expect(rateLabel(0, 0)).toBe('—'); expect(rateLabel(0, 2)).toBe('0.0%'); });
  it('keeps empty architectures visible and missing metadata null', () => {
    const cards = architectureTotals([summary()]); expect(cards).toHaveLength(4); expect(cards.find(a => a.name === 'Web B')).toMatchObject({ runs: 0, latest: null });
    expect(summaryFromRun(run({ run_details: {} }))).toMatchObject({ model: null, exploration_complete: null, exploration_stop_reason: null });
  });
  it('excludes skipped from execution and includes timeout and flaky outcomes', () => {
    const s = summaryFromRun(run({ execution_results: ['passed', 'failed', 'skipped', 'timed_out', 'flaky'].map((status, i) => ({ id: i, status })) }));
    expect(s).toMatchObject({ executed: 4, passed: 1, failed: 1, skipped: 1, timed_out: 1, flaky: 1 });
  });
  it('separates execution completeness from exploration and producer state', () => {
    expect(executionLabel(summary({ generated: 3 }))).toBe('Partial (2 / 3)');
    expect(executionLabel(summary({ execution_state: 'incomplete' }))).toContain('All results recorded');
    expect(aggregate([summary()]).stopped).toBe(1);
  });
  it('adapts mobile and web case IDs without inventing assertions', () => {
    const c = adaptCases(run({ test_cases: [{ test_case_id: 'W01', title: 'A web case', expectedResult: 'Destination opens', steps: ['Click'] }], execution_results: [{ test_case: 'W01', status: 'passed' }] }))[0];
    expect(c).toMatchObject({ id: 'W01', objective: 'A web case', expected: 'Destination opens', result: { status: 'passed' } }); expect(c.assertions).toBeUndefined();
  });
  it('labels only recorded case durations and preserves zero', () => { expect(recordedTime(run({ execution_results: [{ duration_ms: 0 }, {}, { duration_ms: -3 }, { duration_ms: 150 }] }))).toEqual({ ms: 150, recorded: 2, total: 4 }); });
  it('never treats missing comparison conditions as equivalent', () => {
    const conditions = comparisonConditions(run(), run());
    expect(conditions.find(c => c.label === 'Model')?.state).toBe('Same'); expect(conditions.find(c => c.label === 'Device / emulator')?.state).toBe('Not recorded');
    expect(comparisonConditions(run({ run_details: { limits: { steps: 10, tokens: 50 } } }), run({ run_details: { limits: { tokens: 50, steps: 10 } } })).find(c => c.label === 'Exploration budget')?.state).toBe('Same');
  });
});
describe('URL filters and exports', () => {
  it('rejects unknown sorting and hostile page sizes', () => { expect(parseFilters(new URLSearchParams('sort=drop_table&size=100000&page=-1&arch=b'))).toMatchObject({ sort: 'date_desc', size: 25, page: 1, arch: 'B' }); });
  it('uses inclusive UTC date range and supports unknown metadata', () => {
    const f = parseFilters(new URLSearchParams('from=2026-10-22&to=2026-10-22&reason=__unknown'));
    expect(filterRows([summary({ exploration_stop_reason: null, created_at: '2026-10-22T23:59:59Z' }), summary({ exploration_stop_reason: null, created_at: '2026-10-23T00:00:00Z' })], f)).toHaveLength(1);
  });
  it('sorts undefined rates last without mutating the input', () => { const rows = [summary({ run_id: 'zero', executed: 0, passed: 0 }), summary({ run_id: 'pass' })]; expect(sortRows(rows, parseFilters(new URLSearchParams('sort=rate_desc')))[0].run_id).toBe('pass'); expect(rows[0].run_id).toBe('zero'); });
  it('exports every row with blanks for unknowns and neutralizes spreadsheet formulas', () => {
    const text = csv(Array.from({ length: 31 }, (_, i) => summary({ run_id: `r-${i}`, app_id: '=1+1', model: null })));
    expect(text.split('\r\n')).toHaveLength(32); expect(text).toContain('"\'=1+1"'); expect(text).not.toContain('"null"');
  });
  it('checks origins safely, including malformed origin headers', () => {
    expect(sameOrigin(new Request('http://localhost/api/auth/login', { headers: { host: 'localhost', origin: 'https://evil.test' } }))).toBe(false);
    expect(sameOrigin(new Request('http://localhost/api/auth/login', { headers: { host: 'localhost', origin: 'broken' } }))).toBe(false);
    expect(sameOrigin(new Request('http://localhost/api/auth/login', { headers: { host: 'localhost', origin: 'http://localhost' } }))).toBe(true);
  });
});
