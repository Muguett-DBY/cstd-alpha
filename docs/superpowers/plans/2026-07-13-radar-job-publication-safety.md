# Radar Job Publication Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent superseded radar workflows from replacing current radar results or job status.

**Architecture:** D1 owns a singleton current-job state and performs conditional run-token transitions. A protected Pages callback claims that state before it publishes radar and job payloads to KV; GitHub Actions uses a small client instead of direct global writes.

**Tech Stack:** TypeScript 6, Cloudflare Pages Functions, D1, Workers KV, GitHub Actions, Vitest.

## Global Constraints

- Work directly on `main` and preserve unrelated `.agent` changes.
- Do not force push and do not use `git add .`.
- Keep existing radar payload and UI contracts compatible.
- Reuse `TEMPLATE_ANALYSIS_WORKER_TOKEN` when a dedicated radar token is absent.
- Every behavior change follows a red-green test cycle.

---

### Task 1: D1 Current-Run State

**Files:**
- Create: `migrations/0019_radar_analysis_state.sql`
- Modify: `migrations/migrations.test.ts`
- Modify: `functions/_shared/radar-jobs.ts`
- Create: `functions/_shared/radar-jobs.test.ts`

**Interfaces:**
- Produces: `queueRadarAnalysisJob`, `startRadarAnalysisJobRun`, `claimRadarAnalysisJobPublication`, `claimRadarAnalysisJobFailure`, `completeRadarAnalysisJobRun`, and `finishRadarAnalysisJobFailure`.

- [x] **Step 1: Write failing migration and state-transition tests**

Cover one-row queue contention, stale replacement, wrong-token rejection, publication/failure claims, and token-usage normalization.

- [x] **Step 2: Run tests to verify RED**

Run: `npx vitest run migrations/migrations.test.ts functions/_shared/radar-jobs.test.ts`

Expected: fail because migration `0019`, the table, and transition exports do not exist.

- [x] **Step 3: Add the migration and minimal conditional SQL implementation**

Use a singleton primary key, random UUID run token, terminal/stale guarded upsert, and `job_id + run_token + expected status` conditions on every transition.

- [x] **Step 4: Run tests to verify GREEN**

Run: `npx vitest run migrations/migrations.test.ts functions/_shared/radar-jobs.test.ts`

Expected: all selected tests pass.

### Task 2: Protected Radar Publication API

**Files:**
- Create: `functions/api/radar-analysis-job.ts`
- Create: `functions/api/radar-analysis-job.test.ts`

**Interfaces:**
- Consumes: Task 1 transition functions and Workers KV.
- Produces: authenticated `start`, `complete`, and `fail` actions returning 200 for current work and 409 for superseded work.

- [x] **Step 1: Write failing endpoint tests**

Assert malformed payload rejection, stale-token no-write behavior, current completion publication, failure publication, and authentication fallback.

- [x] **Step 2: Run tests to verify RED**

Run: `npx vitest run functions/api/radar-analysis-job.test.ts`

Expected: fail because the endpoint does not exist.

- [x] **Step 3: Implement validation, claims, KV writes, and terminal transitions**

Build public job metadata server-side from the claimed D1 row. Require a `v2` radar cache and matching `radarGeneratedAt` for completion.

- [x] **Step 4: Run tests to verify GREEN**

Run: `npx vitest run functions/api/radar-analysis-job.test.ts`

Expected: all endpoint tests pass and stale cases record zero KV writes.

### Task 3: Website Queue And Workflow Client

**Files:**
- Modify: `functions/api/radar-scan.ts`
- Modify: `functions/api/radar-scan.test.ts`
- Create: `scripts/radar-analysis-job-client.ts`
- Create: `scripts/radar-analysis-job-client.test.ts`
- Modify: `.github/workflows/radar-analysis.yml`
- Modify: `scripts/radar-analysis.test.ts`
- Modify: `scripts/project-hygiene.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1 queue function and Task 2 endpoint.
- Produces: dispatch payload `{ job_id, run_token }`; CLI actions `start`, `complete`, and `fail`.

- [x] **Step 1: Write failing API, client, and workflow contract tests**

Assert atomic job reuse, dispatch run-token propagation, 409-as-superseded handling, fixed radar concurrency, and absence of direct latest-result writes.

- [x] **Step 2: Run tests to verify RED**

Run: `npx vitest run functions/api/radar-scan.test.ts scripts/radar-analysis-job-client.test.ts scripts/radar-analysis.test.ts scripts/project-hygiene.test.ts`

Expected: fail on missing client and old workflow/dispatch contracts.

- [x] **Step 3: Implement the website and workflow integration**

Require D1 for new radar jobs, queue through the singleton state, pass the run token to dispatch, and make conditional callback steps own all result publication.

- [x] **Step 4: Run focused tests to verify GREEN**

Run: `npx vitest run functions/api/radar-scan.test.ts scripts/radar-analysis-job-client.test.ts scripts/radar-analysis.test.ts scripts/project-hygiene.test.ts`

Expected: all selected tests pass.

### Task 4: Release Verification

**Files:**
- Verify all changed files only.

- [x] **Step 1: Run complete local gates**

Run sequentially: `npm test`, `npm run lint`, `npm run typecheck:functions`, `npm run build`, `npm audit --audit-level=moderate`, and `git diff --check`.

Expected: exit 0, zero test failures, zero lint warnings, and zero moderate-or-higher vulnerabilities.

- [x] **Step 2: Apply and inspect the migration locally**

Run local D1 migrations and `PRAGMA table_info(radar_analysis_state)`.

Expected: migration applies and all state/run-token columns are present.

- [ ] **Step 3: Stage only intended files, commit, and push main**

Review `git diff`, explicitly add this plan's files, commit with a radar lifecycle fix message, and push `origin/main` without force.

- [ ] **Step 4: Verify CI, deployment, and production behavior**

Wait for the pushed GitHub Actions run and Cloudflare Pages deployment, confirm the remote D1 schema, smoke authenticated/anonymous API behavior, and use a real browser for the radar view without triggering a paid model run.
