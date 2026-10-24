export type Outcome = 'passed' | 'failed' | 'skipped' | 'timed_out' | 'flaky';
export type JsonObject = Record<string, unknown>;
export interface Summary {
  run_id: string; platform: 'web' | 'mobile'; architecture: 'A' | 'B';
  app_id: string; comparison_id: string; created_at: string; execution_state: string;
  model: string | null; exploration_stop_reason: string | null; exploration_complete: boolean | null;
  generated: number; executed: number; passed: number; failed: number; skipped: number; timed_out: number; flaky: number;
}
export interface Run extends JsonObject {
  run_id: string; platform: 'web' | 'mobile'; architecture: 'A' | 'B';
  app_id: string; comparison_id: string; created_at: string; execution_state: string;
  run_details: JsonObject; memory_log: JsonObject[]; test_cases: JsonObject[]; execution_results: JsonObject[];
}
export interface CaseView {
  id: string; objective: string; category: string | null; setup: unknown; steps: unknown;
  expected: unknown; assertions: unknown; cleanup: unknown; preconditions: unknown;
  result: JsonObject | null; raw: JsonObject;
}
