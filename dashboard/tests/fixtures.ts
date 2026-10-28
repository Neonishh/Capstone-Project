import type { Run, Summary } from '../src/lib/types';
import { summaryFromRun } from '../src/lib/metrics';
export function run(overrides: Partial<Run> = {}): Run {
  return { run_id: 'fixture-mobile-b', platform: 'mobile', architecture: 'B', app_id: 'wdio-demo', comparison_id: 'experiment-01', created_at: '2026-10-22T17:00:00Z', execution_state: 'completed', run_details: { stop_reason: 'step_budget', exploration_complete: false, llm: { model: 'fixture-model' } }, memory_log: [{ step: 1, action: 'tap', target: 'Login', from_title: 'Home', to_title: 'Login' }], test_cases: [
    { id: 'TC001', objective: 'Login opens an editable email field', category: 'navigation', setup: [{ action: 'launch' }], steps: [{ action: 'tap', target: 'Login' }], expected_result: 'Email field is editable', verification: { editable: true }, cleanup: [{ action: 'reset' }] },
    { id: 'TC002', objective: 'Invalid email shows validation', category: 'invalid_input', steps: [{ action: 'type', text: 'invalid' }], expected_result: 'Validation message is visible' }
  ], execution_results: [{ id: 'TC001', status: 'passed', duration_ms: 100 }, { id: 'TC002', status: 'failed', duration_ms: 200, error: 'Validation message was not visible', attachments: ['local/screenshot.png'] }], ...overrides };
}
export function summary(overrides: Partial<Summary> = {}): Summary { return { ...summaryFromRun(run()), ...overrides }; }
export const fixtureRuns = [run(), run({ run_id: 'fixture-mobile-a', architecture: 'A', run_details: { llm: { model: 'fixture-model' } } }), run({ run_id: 'fixture-web-a', platform: 'web', architecture: 'A', app_id: 'sample-web', comparison_id: 'web-01', run_details: {}, test_cases: [], execution_results: [] })];
export const fixtureSummaries = fixtureRuns.map(summaryFromRun);
