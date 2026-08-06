# Radar Failed Refresh Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the last successful radar visible while clearly reporting that its latest background refresh failed.

**Architecture:** Put radar API-result interpretation in pure helpers under `src/radar-ui.ts`. Reuse the same state resolver in the initial request and polling paths, and use a pure label helper in `RadarView` so failed cached scans cannot be presented as successful reuse.

**Tech Stack:** React 19, TypeScript 6, Vitest.

## Global Constraints

- Work directly on `main`; do not force push or use `git add .`.
- Preserve unrelated `.agent` files unstaged.
- Do not change API, database, workflow, environment-variable, or dependency contracts.
- Keep the last successful radar visible after a failed refresh.
- Follow red-green TDD before editing production code.

---

### Task 1: Reproduce Failed Radar Result Interpretation

**Files:**
- Modify: `src/radar-ui.test.ts`

**Interfaces:**
- Consumes: planned `resolveRadarResultState(result, hasExistingRadar)` and `radarStatusLabel(radar, job)` exports from `src/radar-ui.ts`.
- Produces: regression coverage for failed, running, cached-completed, and new-completed radar results.

- [x] **Step 1: Add failed-result tests**

Import the two planned helpers and assert:

```ts
expect(resolveRadarResultState({
  radar: { refreshWarning: undefined },
  job: { status: "failed", message: "后台分析失败，已保留旧扫描。" },
}, true)).toEqual({ phase: "ready", error: "后台分析失败，已保留旧扫描。" });

expect(resolveRadarResultState({ radar: null, job: { status: "failed" } }, false)).toEqual({
  phase: "error",
  error: "雷达扫描失败，请稍后重试。",
});

expect(radarStatusLabel({ fromCache: true }, { status: "failed" })).toBe("刷新失败，已保留上次扫描");
```

- [x] **Step 2: Add compatibility tests**

Assert that an existing radar plus `running` resolves to `refreshing`, a completed cached scan remains `复用稳定扫描`, and a completed non-cached scan remains `本次新扫描`.

- [x] **Step 3: Run the focused test and verify RED**

Run: `npx vitest run --coverage.enabled=false src/radar-ui.test.ts src/App.test.ts`

Expected: FAIL because `resolveRadarResultState` and `radarStatusLabel` are not exported yet.

### Task 2: Centralize Radar Result State

**Files:**
- Modify: `src/radar-ui.ts`
- Modify: `src/App.tsx`
- Modify: `src/RadarView.tsx`

**Interfaces:**
- Produces: `resolveRadarResultState(result, hasExistingRadar): { phase: "loading" | "refreshing" | "ready" | "error"; error: string }`.
- Produces: `radarStatusLabel(radar, job): string`.
- Consumes: `RadarScan.refreshWarning`, `RadarScan.fromCache`, and `RadarAnalysisJob.status/message`.

- [x] **Step 1: Implement the pure helpers**

Add structural input types and implement these rules:

```ts
if (jobRunning) {
  return { phase: result.radar || hasExistingRadar ? "refreshing" : "loading", error: warning };
}
if (result.job?.status === "failed") {
  const hasRadar = Boolean(result.radar || hasExistingRadar);
  return {
    phase: hasRadar ? "ready" : "error",
    error: result.job.message?.trim() || warning || (hasRadar
      ? "本次刷新失败，已保留上次扫描。请稍后重试。"
      : "雷达扫描失败，请稍后重试。"),
  };
}
return { phase: result.radar ? "ready" : "error", error: warning };
```

The status helper must return `后台分析中` for queued/running, `刷新失败，已保留上次扫描` for failed, and retain the current cached/new labels for completed results.

- [x] **Step 2: Use one resolver in both App paths**

Import `resolveRadarResultState` in `src/App.tsx`. After updating `radar`, `job`, and diagnostics in both `loadRadar` and the polling callback, call the helper and pass its `phase` and `error` to `setRadarPhase` and `setRadarError`.

- [x] **Step 3: Use the status-label helper in RadarView**

Import `radarStatusLabel` in `src/RadarView.tsx` and replace the nested status-label expression with `radarStatusLabel(radar, job)`.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run --coverage.enabled=false src/radar-ui.test.ts src/App.test.ts`

Expected: both files pass, including the new failed-refresh cases.

### Task 3: Release Verification

**Files:**
- Verify only the three source files, one test file, and the design/plan documents listed above.

- [x] **Step 1: Run local gates**

Run sequentially: `npm test`, `npm run lint`, `npm run typecheck:functions`, `npm run build`, `npm audit --audit-level=moderate`, and `git diff --check -- . ':(exclude).agent'`.

- [ ] **Step 2: Review and publish**

Explicitly stage intended files, inspect the cached diff, commit with a focused UI reliability message, and push `origin/main` without force.

- [ ] **Step 3: Verify production**

Wait for the exact pushed SHA's GitHub Actions run, confirm its Cloudflare production deployment, then perform authenticated production radar reads and browser-check the radar page without triggering a paid refresh.
