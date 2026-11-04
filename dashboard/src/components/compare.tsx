'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, GitCompareArrows, Info } from 'lucide-react';
import { useApi } from './shell';
import { useQuery } from './filters';
import type { CaseView, Run, Summary } from '@/lib/types';
import { adaptCases, comparisonConditions, explorationLabel, rateLabel, summaryFromRun } from '@/lib/metrics';
import { Badge, EmptyState, ErrorState, RunId, SectionHeading, Skeleton, Value } from './ui';
import { OutcomeChart } from './charts';

type BadgeTone = 'neutral' | 'green' | 'red' | 'amber' | 'purple' | 'blue';

function executionCompletion(summary: Summary) {
  return summary.generated ? `${(summary.executed / summary.generated * 100).toFixed(1)}%` : '—';
}

function explorationState(summary: Summary): { label: string; tone: BadgeTone; detail: string } {
  if (summary.exploration_complete === true) {
    return { label: 'Complete', tone: 'green', detail: 'Run metadata reports completed exploration.' };
  }
  if (summary.exploration_complete === false) {
    return { label: 'Partial', tone: 'amber', detail: explorationLabel(summary) };
  }
  return { label: 'Not recorded', tone: 'neutral', detail: 'Exploration status was not recorded.' };
}

function statusTone(status: string): BadgeTone {
  if (status === 'passed') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'flaky' || status === 'timed_out') return 'amber';
  return 'neutral';
}

function statusLabel(status: string) {
  if (!status) return 'Not recorded';
  return status.replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase());
}

function evidenceText(value: unknown) {
  if (value === null || value === undefined || value === '') return 'Not recorded';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function RunSummaryCard({ run }: { run: Run }) {
  const summary = summaryFromRun(run);
  const exploration = explorationState(summary);
  const notExecuted = Math.max(0, summary.generated - summary.executed);

  return <section className={`panel comparison-run-card architecture-${run.architecture.toLowerCase()}`}>
    <div className="section-heading comparison-card-heading">
      <Badge tone={run.architecture === 'A' ? 'blue' : 'purple'}>Architecture {run.architecture}</Badge>
      <RunId id={run.run_id} />
    </div>
    <h2>{run.app_id}</h2>
    <p className="comparison-model">{summary.model || 'Model not recorded'}</p>

    <div className="compare-metrics comparison-primary-metrics">
      <div><span>Generated</span><strong>{summary.generated}</strong></div>
      <div><span>Executed</span><strong>{summary.executed}</strong></div>
      <div><span>Execution completion</span><strong>{executionCompletion(summary)}</strong><small>{summary.executed} / {summary.generated} generated</small></div>
      <div><span>Execution pass rate</span><strong>{rateLabel(summary.passed, summary.executed)}</strong><small>{summary.passed} / {summary.executed} executed</small></div>
    </div>

    <div className="comparison-outcome-counts" aria-label={`Architecture ${run.architecture} outcome counts`}>
      <div className="outcome-passed"><span>Passed</span><strong>{summary.passed}</strong></div>
      <div className="outcome-failed"><span>Failed</span><strong>{summary.failed}</strong></div>
      <div className="outcome-flaky"><span>Flaky</span><strong>{summary.flaky}</strong></div>
      <div><span>Not executed</span><strong>{notExecuted}</strong></div>
    </div>

    <div className="comparison-exploration">
      <div><span>Exploration</span><Badge tone={exploration.tone}>{exploration.label}</Badge></div>
      <p>{exploration.detail}</p>
    </div>
    <Link className="text-link comparison-run-link" href={`/runs/${run.run_id}`}>View run details →</Link>
  </section>;
}

function TestCaseTable({ run }: { run: Run }) {
  const cases = adaptCases(run);
  return <div className="comparison-case-column">
    <div className="comparison-case-title">
      <Badge tone={run.architecture === 'A' ? 'blue' : 'purple'}>Architecture {run.architecture}</Badge>
      <span>{cases.length} generated</span>
    </div>
    <div className="table-scroll comparison-case-table-wrap">
      <table className="comparison-case-table">
        <thead><tr><th>Test</th><th>Objective and expected check</th><th>Status</th></tr></thead>
        <tbody>{cases.length ? cases.map(testCase => {
          const status = String(testCase.result?.status ?? '');
          const expected = testCase.expected ?? testCase.assertions;
          return <tr key={testCase.id}>
            <td><Link href={`/runs/${run.run_id}?tab=cases&case=${encodeURIComponent(testCase.id)}`} className="mono text-link">{testCase.id}</Link></td>
            <td><strong>{testCase.objective}</strong><span className="comparison-expected" title={evidenceText(expected)}>{evidenceText(expected)}</span></td>
            <td><Badge tone={statusTone(status)}>{statusLabel(status)}</Badge></td>
          </tr>;
        }) : <tr><td colSpan={3}><span className="not-recorded">No generated test cases</span></td></tr>}</tbody>
      </table>
    </div>
  </div>;
}

function attentionCases(run: Run): { run: Run; testCase: CaseView; status: string; error: string }[] {
  return adaptCases(run).flatMap(testCase => {
    const status = String(testCase.result?.status ?? '');
    if (!['failed', 'flaky', 'timed_out'].includes(status)) return [];
    return [{ run, testCase, status, error: evidenceText(testCase.result?.error) }];
  });
}

export function Compare() {
  const { params, update } = useQuery();
  const { data, error, loading, refresh } = useApi<{ rows: Summary[]; total: number }>('/api/runs?size=50');
  const [all, setAll] = useState<Summary[]>([]);
  const [pair, setPair] = useState<[Run, Run] | null>(null);
  const [pairError, setPairError] = useState('');
  const [pairLoading, setPairLoading] = useState(false);
  const a = params.get('a') || '';
  const b = params.get('b') || '';
  const platform = params.get('platform') || '';
  const app = params.get('app') || '';
  const cmp = params.get('cmp') || '';

  // Comparison candidates must include every page, rather than silently using the first 50 runs.
  useEffect(() => {
    if (!data) return;
    const controller = new AbortController();
    (async () => {
      let rows = [...data.rows];
      for (let page = 2; rows.length < data.total; page++) {
        const response = await fetch(`/api/runs?size=50&page=${page}`, { signal: controller.signal });
        if (!response.ok) throw new Error('Unable to load all comparison candidates.');
        rows = rows.concat((await response.json()).rows);
      }
      if (!controller.signal.aborted) setAll(rows);
    })().catch(nextError => { if (!controller.signal.aborted) setPairError(nextError.message); });
    return () => controller.abort();
  }, [data]);

  useEffect(() => {
    setPair(null);
    setPairError('');
    if (!a || !b) return;
    const controller = new AbortController();
    setPairLoading(true);
    Promise.all([a, b].map(async id => {
      const response = await fetch(`/api/runs/${encodeURIComponent(id)}`, { signal: controller.signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not load the selected run.');
      return body.run as Run;
    })).then(([one, two]) => {
      if (one.run_id === two.run_id || one.platform !== two.platform || one.app_id !== two.app_id || one.comparison_id !== two.comparison_id || one.architecture === two.architecture) {
        throw new Error('Select different A and B runs from the same platform, app, and comparison ID.');
      }
      const next: [Run, Run] = one.architecture === 'A' ? [one, two] : [two, one];
      if ((platform && next[0].platform !== platform) || (app && next[0].app_id !== app) || (cmp && next[0].comparison_id !== cmp)) {
        throw new Error('The selected runs do not match the comparison filters.');
      }
      setPair(next);
      if (!platform || !app || !cmp || a !== next[0].run_id) {
        update({ platform: next[0].platform, app: next[0].app_id, cmp: next[0].comparison_id, a: next[0].run_id, b: next[1].run_id });
      }
    }).catch(nextError => { if (!controller.signal.aborted) setPairError(nextError.message); })
      .finally(() => { if (!controller.signal.aborted) setPairLoading(false); });
    return () => controller.abort();
  }, [a, b, platform, app, cmp, data]);

  const values = (rows: Summary[], key: 'app_id' | 'comparison_id') => [...new Set(rows.map(row => row[key]))].sort();
  const candidates = all.filter(row => row.platform === platform && row.app_id === app && row.comparison_id === cmp);
  const attention = pair ? pair.flatMap(attentionCases) : [];

  return <div id="page-content" className="page">
    <div className="page-heading"><div><div className="eyebrow">SIDE BY SIDE</div><h1>Compare the experiment<span className="accent">.</span></h1><p>Select equivalent runs and compare their recorded outcomes and test evidence.</p></div><div className="heading-icon"><GitCompareArrows size={28} /></div></div>
    <div className="notice comparison-disclaimer"><Info size={18} /><p>A higher execution pass rate or larger case count does not automatically mean a better architecture. Different generated suites may have different difficulty.</p></div>
    <section className="panel comparison-picker"><div className="filter-grid">
      <label>1 · Platform<select value={platform} onChange={event => update({ platform: event.target.value, app: null, cmp: null, a: null, b: null })}><option value="">Choose platform</option><option value="web">Web</option><option value="mobile">Mobile</option></select></label>
      <label>2 · Application<select disabled={!platform} value={app} onChange={event => update({ app: event.target.value, cmp: null, a: null, b: null })}><option value="">Choose app</option>{values(all.filter(row => row.platform === platform), 'app_id').map(value => <option key={value}>{value}</option>)}</select></label>
      <label>3 · Comparison ID<select disabled={!app} value={cmp} onChange={event => update({ cmp: event.target.value, a: null, b: null })}><option value="">Choose experiment</option>{values(all.filter(row => row.platform === platform && row.app_id === app), 'comparison_id').map(value => <option key={value}>{value}</option>)}</select></label>
      {(['A', 'B'] as const).map(architecture => <label key={architecture}>{architecture === 'A' ? '4' : '5'} · Run {architecture}<select disabled={!cmp} value={architecture === 'A' ? a : b} onChange={event => update({ [architecture.toLowerCase()]: event.target.value })}><option value="">Choose run {architecture}</option>{candidates.filter(row => row.architecture === architecture).map(row => <option key={row.run_id} value={row.run_id}>{row.run_id.slice(0, 8)} · {row.model || 'Unknown model'}</option>)}</select></label>)}
    </div></section>

    {error && <ErrorState message={error} retry={refresh} />}
    {pairError && <div className="error-banner" role="alert">{pairError}</div>}
    {(loading || pairLoading) && !pair && <Skeleton rows={3} />}

    {pair ? <>
      <section className="panel comparison-context" aria-label="Selected comparison">
        <div><span>Selected comparison</span><h2>{pair[0].app_id}</h2></div>
        <div><span>Comparison ID</span><strong className="mono">{pair[0].comparison_id}</strong></div>
      </section>

      <div className="comparison-run-grid">{pair.map(run => <RunSummaryCard key={run.run_id} run={run} />)}</div>

      <section className="panel"><SectionHeading title="Outcome comparison" caption="Recorded execution outcomes for the selected generated suites." /><OutcomeChart grouped data={pair.map(run => ({ name: `Architecture ${run.architecture}`, ...summaryFromRun(run) }))} /></section>

      <section className="panel comparison-cases-panel"><SectionHeading title="Recorded test cases" caption="Objectives and expected checks are shown as recorded. A passing status does not by itself prove test validity." /><div className="comparison-case-grid">{pair.map(run => <TestCaseTable key={run.run_id} run={run} />)}</div></section>

      {attention.length > 0 && <section className="panel comparison-attention-panel"><SectionHeading title="Cases requiring attention" caption="Failed, timed-out and flaky outcomes need review before being classified as application defects." /><div className="comparison-attention-list">{attention.map(({ run, testCase, status, error: message }) => <article key={`${run.run_id}-${testCase.id}`}><div className="comparison-attention-heading"><AlertTriangle size={17} /><Badge tone={run.architecture === 'A' ? 'blue' : 'purple'}>Architecture {run.architecture}</Badge><strong>{testCase.id}</strong><Badge tone={statusTone(status)}>{statusLabel(status)}</Badge></div><h3>{testCase.objective}</h3>{message !== 'Not recorded' ? <details><summary>Error details</summary><pre className="inline-json">{message}</pre></details> : <p className="muted">No error message was recorded.</p>}<Link href={`/runs/${run.run_id}?tab=cases&case=${encodeURIComponent(testCase.id)}`} className="text-link">Review this test →</Link></article>)}</div></section>}

      {attention.length === 0 && <section className="panel comparison-clear-panel"><CheckCircle2 size={20} /><div><strong>No failed, timed-out or flaky outcomes recorded</strong><p>This describes execution outcomes only; test validity and oracle correctness still require review.</p></div></section>}

      {pair[0].platform === 'mobile' && <section className="panel"><SectionHeading title="Conditions check" caption="Unknown conditions are never treated as a match." /><div className="table-scroll"><table><thead><tr><th>Condition</th><th>Architecture A</th><th>Architecture B</th><th>Assessment</th></tr></thead><tbody>{comparisonConditions(...pair).map(condition => <tr key={condition.label}><th>{condition.label}</th><td><Value value={condition.a} /></td><td><Value value={condition.b} /></td><td><Badge tone={condition.state === 'Same' ? 'green' : condition.state === 'Different' ? 'amber' : 'neutral'}>{condition.state}</Badge></td></tr>)}</tbody></table></div></section>}
    </> : !pairLoading && !loading && !pairError && <section className="panel"><EmptyState title={cmp && (!candidates.some(row => row.architecture === 'A') || !candidates.some(row => row.architecture === 'B')) ? 'A matching architecture is not available yet' : 'Choose two runs to compare'} description="Comparison starts when A and B have results for the same app and experiment. You can still inspect each run individually." action={<Link href="/runs" className="button secondary">Browse recorded runs</Link>} /></section>}
  </div>;
}
