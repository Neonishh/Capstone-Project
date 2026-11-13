-- Web C is the Microsoft Playwright Test Agents arm.
-- Upload Web C results to public.runs with platform='web', architecture='C'.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.runs
  DROP CONSTRAINT runs_architecture_check,
  ADD CONSTRAINT runs_architecture_check CHECK (
    architecture IN ('A', 'B') OR (platform = 'web' AND architecture = 'C')
  );

CREATE OR REPLACE VIEW public.web_c_runs WITH (security_invoker = true) AS
SELECT run_id, platform, architecture, app_id, comparison_id, created_at,
       execution_state, exploration_stop_reason, exploration_complete, model,
       generated, executed, passed, failed, timed_out, skipped, flaky
FROM public.run_summary
WHERE platform = 'web' AND architecture = 'C';

REVOKE ALL ON public.web_c_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.web_c_runs TO service_role;
COMMIT;

WITH signatures AS (
  SELECT table_name, jsonb_agg(jsonb_build_array(column_name, data_type)
                              ORDER BY ordinal_position) AS columns
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name IN ('web_b_runs', 'web_c_runs')
  GROUP BY table_name
)
SELECT
  (SELECT jsonb_array_length(columns) FROM signatures WHERE table_name = 'web_c_runs') AS web_c_columns,
  (SELECT columns FROM signatures WHERE table_name = 'web_c_runs') =
  (SELECT columns FROM signatures WHERE table_name = 'web_b_runs') AS same_columns_and_types_as_web_b,
  (SELECT count(*) FROM public.web_c_runs) AS web_c_rows,
  has_table_privilege('service_role', 'public.web_c_runs', 'SELECT') AS service_role_can_read,
  has_table_privilege('anon', 'public.web_c_runs', 'SELECT') AS anon_can_read,
  has_table_privilege('authenticated', 'public.web_c_runs', 'SELECT') AS authenticated_can_read;
