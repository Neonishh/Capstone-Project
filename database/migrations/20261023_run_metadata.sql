-- For an existing runs table. Preserves every stored run; no backfill is guessed.
-- Apply only if the live schema/views lack these fields. Current CSV exports
-- already contain the view columns, so a migration may not be needed there.
begin;
alter table public.runs add column if not exists run_details jsonb not null default '{}'::jsonb;
drop view if exists public.web_a_runs, public.web_b_runs, public.mobile_a_runs, public.mobile_b_runs;
drop view if exists public.run_summary;
create or replace view public.run_summary with (security_invoker=true) as
select r.run_id, r.platform, r.architecture, r.app_id,
 r.comparison_id, r.created_at, r.execution_state,
 r.run_details->>'stop_reason' as exploration_stop_reason,
 case when jsonb_typeof(r.run_details->'exploration_complete') = 'boolean'
      then (r.run_details->>'exploration_complete')::boolean end as exploration_complete,
 r.run_details->'llm'->>'model' as model,
 jsonb_array_length(r.test_cases) as generated,
 (select count(*) from jsonb_array_elements(r.execution_results) e where e->>'status' <> 'skipped') as executed,
 (select count(*) from jsonb_array_elements(r.execution_results) e where e->>'status' = 'passed') as passed,
 (select count(*) from jsonb_array_elements(r.execution_results) e where e->>'status' = 'failed') as failed,
 (select count(*) from jsonb_array_elements(r.execution_results) e where e->>'status' = 'timed_out') as timed_out,
 (select count(*) from jsonb_array_elements(r.execution_results) e where e->>'status' = 'skipped') as skipped,
 (select count(*) from jsonb_array_elements(r.execution_results) e where e->>'status' = 'flaky') as flaky
from public.runs r;
create or replace view public.web_a_runs with (security_invoker=true) as select * from public.run_summary where platform='web' and architecture='A';
create or replace view public.web_b_runs with (security_invoker=true) as select * from public.run_summary where platform='web' and architecture='B';
create or replace view public.mobile_a_runs with (security_invoker=true) as select * from public.run_summary where platform='mobile' and architecture='A';
create or replace view public.mobile_b_runs with (security_invoker=true) as select * from public.run_summary where platform='mobile' and architecture='B';
revoke all on public.run_summary, public.web_a_runs, public.web_b_runs, public.mobile_a_runs, public.mobile_b_runs from anon, authenticated;
grant select on public.run_summary, public.web_a_runs, public.web_b_runs, public.mobile_a_runs, public.mobile_b_runs to service_role;
commit;
