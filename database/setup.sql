-- Shared Supabase setup: use for a fresh project or an existing capstone database.
-- Preserves stored runs; removes only the unused owner column and rebuilds views.
begin;
drop view if exists public.web_a_runs, public.web_b_runs, public.mobile_a_runs, public.mobile_b_runs;
drop view if exists public.run_summary;
alter table if exists public.runs drop column if exists owner;
create table if not exists public.runs (
  run_id text primary key,
  platform text not null check (platform in ('web','mobile')),
  architecture text not null check (architecture in ('A','B')),
  app_id text not null,
  comparison_id text not null,
  created_at timestamptz not null,
  execution_state text not null check (execution_state in ('completed','incomplete')),
  memory_log jsonb not null check (jsonb_typeof(memory_log) = 'array'),
  test_cases jsonb not null check (jsonb_typeof(test_cases) = 'array'),
  execution_results jsonb not null check (jsonb_typeof(execution_results) = 'array')
);
create index if not exists runs_comparison on public.runs(platform, app_id, comparison_id, architecture);
alter table public.runs enable row level security;
revoke all on public.runs from anon, authenticated;
grant select, insert, update on public.runs to service_role;

create or replace view public.run_summary with (security_invoker=true) as
select r.run_id, r.platform, r.architecture, r.app_id,
 r.comparison_id, r.created_at, r.execution_state,
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
