# Watchlist Ranking Finalization Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a claimed watchlist ranking callback immediately retryable when its terminal D1 write fails.

**Architecture:** Preserve the existing `running -> finalizing:<token> -> completed/failed_retryable` lifecycle. Wrap terminal writes in a guarded recovery path that conditionally records `failed_retryable` with the finalizing token and always returns a sanitized HTTP response.

**Tech Stack:** TypeScript 6, Cloudflare Pages Functions, D1, Vitest.

## Global Constraints

- Work directly on `main`; do not force push or use `git add .`.
- Preserve unrelated `.agent` files unstaged.
- Do not relax run-token checks or expose internal database errors.
- Follow red-green TDD before editing production code.

---

### Task 1: Reproduce Finalization Recovery Failures

**Files:**
- Modify: `functions/api/job-callbacks.test.ts`

**Interfaces:**
- Consumes: `onRequestPost` from `functions/api/watchlist-ranking-job.ts`.
- Produces: regression coverage for a failed completion write and a failed recovery write.

- [x] **Step 1: Add failure injection to the D1 callback fake**

Extend `watchlistRankingCompletionDb` with options that throw once for SQL containing `SET status = 'completed'` and optionally throw for SQL containing `SET status = 'failed_retryable'`.

- [x] **Step 2: Add the two recovery assertions**

The first test expects HTTP 500, a sanitized error, and a failure-update bind whose last argument is `finalizing:current-run-token`. The second expects HTTP 500 even when both terminal writes throw.

- [x] **Step 3: Run the focused test and verify RED**

Run: `npx vitest run functions/api/job-callbacks.test.ts`

Expected: both new tests fail because the callback currently rejects after the injected completion exception.

### Task 2: Guard The Claimed Callback

**Files:**
- Modify: `functions/api/watchlist-ranking-job.ts`

**Interfaces:**
- Consumes: `writeWatchlistRankingFailure` and the claimed `finalizingToken`.
- Produces: sanitized HTTP 500 with an immediate guarded `failed_retryable` transition when possible.

- [x] **Step 1: Put terminal writes inside one try block**

Keep the existing success and explicit-error branches unchanged inside the protected block.

- [x] **Step 2: Add conditional recovery**

On an exception, call `writeWatchlistRankingFailure` with a fixed persistence-failure message and `finalizingToken`. Return 409 on a conditional miss; return sanitized 500 after successful recovery or after a recovery exception.

- [x] **Step 3: Run the focused test and verify GREEN**

Run: `npx vitest run functions/api/job-callbacks.test.ts`

Expected: all callback tests pass.

### Task 3: Release Verification

**Files:**
- Verify only the files listed above and these design/plan documents.

- [x] **Step 1: Run local gates**

Run sequentially: `npm test`, `npm run lint`, `npm run typecheck:functions`, `npm run build`, `npm audit --audit-level=moderate`, and `git diff --check -- . ':(exclude).agent'`.

- [ ] **Step 2: Review and publish**

Explicitly stage intended files, inspect the cached diff, commit with a focused reliability message, and push `origin/main` without force.

- [ ] **Step 3: Verify production**

Wait for the pushed GitHub Actions run, confirm the matching Cloudflare production deployment, then verify the protected callback returns 401 without a worker token and that authenticated watchlist ranking reads remain healthy without starting a paid scoring run.
