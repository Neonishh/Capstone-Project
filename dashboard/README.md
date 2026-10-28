# Capstone QA Observatory

A separate, read-only Next.js dashboard for the four testing architectures. It uses your existing Supabase `runs` table and `run_summary` view. Pipelines upload independently; the dashboard does not run tests or modify database records.

## Run locally

Requirements: Node.js 22 LTS or newer supported by Next.js, npm, and an internet connection to Supabase. No Android emulator, Python environment, or model API key is needed.

From the repository root in PowerShell:

```powershell
cd dashboard
npm.cmd ci
Copy-Item .env.example .env.local
# Fill in the Supabase settings in .env.local, then:
npm.cmd run dev
```

Open **http://127.0.0.1:3000**. If `.env.local` already exists and is configured, keep it; do not overwrite it with the example. It has already been prepared on the original development laptop. Teammates must supply their own authorized configuration because this file is ignored by Git.

```dotenv
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-server-key
DASHBOARD_AUTH_MODE=local
```

All database access runs on the Next.js server. Never prefix a secret key with `NEXT_PUBLIC_`. Never commit `.env.local` or copy model-provider keys into this application. The dashboard only issues database SELECT requests. Existing shared schema setup and uploads are documented in [the database guide](../database/TEAM_SETUP.md).

The supplied scripts bind to loopback, and local-mode API/page guards reject external hostnames. `DASHBOARD_AUTH_MODE=local` is for demonstrations on your own machine. It is not authentication for a publicly hosted server. All authorized hosted teammates can read all project runs; per-user run ownership is not implemented.

## What is included

| Page | Features |
| --- | --- |
| Overview | All four architecture cards, honest missing-data states, weighted totals, counts/proportions with accessible table alternatives, exploration reasons, recent runs |
| Runs | Run-ID search, URL filters, allowed sorts, 10/25/50-row pagination, selection up to 20 runs, CSV and selected JSON export |
| Run details | Summary; searchable cases and setup/actions/assertions/cleanup; failure explanations and case links; exploration timeline; searchable collapsible original JSON |
| Compare | Platform → app → comparison ID → A/B runs; matching validation; conditions matrix; grouped outcome counts/proportions; pass rates, categories, and recorded durations |
| Exports | CSV for every matching run across pages, complete run JSON, progress and error feedback |
| Methodology | Metric definitions, architecture descriptions, comparison cautions, unavailable measurements |

There are light/dark themes, mobile navigation, keyboard focus indicators, keyboard tab navigation, manual refresh, and optional 1/5/15-minute refresh (off initially). Filters, detail tabs, case selection/search/status, and comparison selections stay in URLs. Browser requests retain previously loaded results if a refresh fails, with a visible warning. Changed run IDs clear the previous run to avoid presenting another run's evidence as current.

## Data contract

| Field | Source |
| --- | --- |
| Run list and counts | `public.run_summary`, collected in ordered pages of up to 1,000 |
| Complete run | `public.runs`, matched by exact `run_id` |
| Generated | Length of `test_cases` |
| Executed | Results excluding skipped; NULL status is excluded like the SQL view |
| Pass rate | Sum of passed / sum of executed × 100; `—` when executed is zero |
| Exploration outcome | `run_details.stop_reason` and `run_details.exploration_complete` |
| Model | `run_details.llm.model` |
| Recorded case time | Sum of available nonnegative `duration_ms`; recorded-count denominator is shown |

The view's model and exploration columns are derived JSON fields, not new physical upload columns. Missing metadata displays **Not recorded**. A budget stop never implies whole-app coverage. Recorded result counts and the producer's `execution_state` are displayed separately for legacy runs whose flags are conservative. Case adapters support `id`/`test_case_id`, `objective`/`title`/`name`, expected-result variants, assertions/verification, and result identifiers including `test_case`.

UTC boundaries apply to date filters. Filters and sorts are validated on the server; a CSV export ignores table pagination. CSV values are quoted and spreadsheet formula prefixes escaped. Detail exports preserve the original record. Reads across pages are not a database snapshot: pause concurrent uploads when collecting a final report dataset.

The backend exposes authenticated `GET /api/overview`, `/api/runs`, `/api/runs/[runId]`, and `/api/export`. `id=...` on export selects JSON; repeated IDs select up to 20 records. Without IDs, export produces filtered CSV. Data responses are private and not cached. All data endpoints independently check access.

## Team sign-in before hosting

1. Create or invite the intended users in **Supabase → Authentication → Users**. Use email/password accounts. There is no public registration form.
2. In the hosting platform's server environment, configure the URL and service-role key plus:

   ```dotenv
   DASHBOARD_AUTH_MODE=supabase
   SUPABASE_ANON_KEY=your-publishable-or-anon-key
   DASHBOARD_ALLOWED_EMAILS=teammate@example.com,reviewer@example.com
   ```

3. Set the hosting project root to `dashboard`, install with `npm ci`, and build with `npm run build`. Configure HTTPS and use the normal Next.js runtime.
4. Check a signed-out browser: protected pages must redirect to `/login`, and direct data APIs must return 401. Then verify an allowed account can sign in and sign out. An account outside the allowlist must be refused.

The server validates the Supabase user, then the email allowlist, on every data request. Login/logout check the request origin. Auth sessions use server-managed cookies; no service key is sent to the browser. Local mode fails closed on Vercel/Cloudflare hosting indicators and external Host values. Other hosts also require explicit `supabase` mode; do not proxy a publicly reachable service to a local-mode server.

**Initial delivery is local.** Successful sign-in with your team's actual accounts and hosting-provider configuration must be verified when those accounts and hosting are configured; automated tests cover the authentication/access rules with controlled responses.

## Verify changes

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run test:e2e
```

Browser tests use deterministic fixtures intercepted only in Playwright, never inserted into Supabase. Tests cover the overview, URL persistence, failed-result case links, comparisons, downloads, error recovery, dark mode, and layouts at 375, 768, and 1280 px. Windows uses installed Edge headlessly. On macOS/Linux, install Chromium with `npx playwright install chromium`; optionally set `PLAYWRIGHT_CHANNEL` to an installed browser channel.

With the local server running and real credentials configured:

```powershell
npm.cmd run test:live
```

This reads live Supabase summaries, checks CSV, opens the newest available web/mobile run's five detail tabs, checks browser runtime errors, and scans browser static artifacts for the configured server key without printing it. It does not write to Supabase. Test screenshots/reports remain in ignored `test-results/` and `playwright-report/`.

After building, `node scripts/verify-access.mjs` starts and stops a temporary hosted-mode server on loopback port 3001. It verifies signed-out API rejection, shared-page redirects, and cross-origin logout rejection without using a real team's passwords.

For a production-mode local demonstration:

```powershell
npm.cmd run build
npm.cmd start
```

Keep `DASHBOARD_AUTH_MODE=local` for this loopback-only demonstration. Stop an existing dev server before starting another on port 3000.

## Troubleshooting and deliberate limits

- **Database summaries unavailable:** check the server credentials, internet access, and shared views. If the existing project lacks `run_summary` or JSON metadata columns, follow the database team's migration instructions. The dashboard does not run schema migrations automatically.
- **No runs available:** upload a run from the corresponding testing pipeline, then refresh. All four architectures are not required to start using the dashboard.
- **Missing model/device/version:** historical metadata was not recorded. Current `.env` values do not relabel old runs.
- **Evidence stored locally:** screenshot/video paths are references, not hosted downloads. Private artifact storage and durable references are future pipeline work.
- **Comparison unavailable:** A and B need the same platform, app, and comparison ID. Equal IDs do not establish equal models, budgets, fixtures, or devices; inspect the conditions matrix.
- Actual token/cost charts, generation-quality scores, whole-app coverage, and whole-pipeline timing require additional recorded measurements. No synthetic values are presented.
- All summary rows are fetched to calculate correct full-selection totals. For a much larger dataset, move filtering and aggregation into indexed SQL queries/RPC with pagination rather than loading every summary into the application server.

Stack: Next.js App Router, React, TypeScript, Tailwind CSS with Radix/CVA component primitives, TanStack Table, Recharts, Zod, Supabase SSR/JS, Vitest, and Playwright. Dependency versions are pinned alongside `package-lock.json` for reproducible installation.
