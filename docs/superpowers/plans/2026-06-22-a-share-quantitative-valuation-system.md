# A-Share Quantitative Valuation System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Ship an A-share-only, auto-filled, editable five-year valuation workspace with deterministic calculation, source provenance, immutable versions, sensitivity analysis, and forecast-versus-actual review.

**Architecture:** Retain valuation_runs as the queue entry point and legacy read model. New append-only D1 tables store source snapshots, forecast versions, assumptions, model outputs, and actual reviews. Browser preview and Pages Functions use the same pure TypeScript contract. The worker creates a baseline from the existing company-evidence package; save runs server-side validation and calculation.

**Tech Stack:** React 19, TypeScript 6, Vitest 4, Cloudflare Pages Functions, Workers Queues, D1, R2.

---

## File map

- Create: migrations/0016_quantitative_valuations.sql
- Modify: migrations/migrations.test.ts
- Create: src/shared/quantitative-valuation.ts and src/shared/quantitative-valuation.test.ts
- Modify: src/shared/valuation.ts and functions/_shared/valuation-engine.ts
- Create: functions/_shared/quantitative-valuation-draft.ts and its tests
- Modify: functions/_shared/research-workbench-db.ts and functions/_shared/valuation-runner.ts
- Create: functions/api/valuation-workspace.ts and its tests
- Modify: functions/api/valuations.ts and functions/api/company-evidence-refresh.ts
- Create: src/quantitative-valuation-state.ts, src/quantitative-valuation-state.test.ts, and src/QuantitativeValuationWorkspace.tsx
- Modify: src/api.ts, src/ValuationLabView.tsx, src/valuation-state.ts, src/valuation-state.test.ts, src/App.css, README.md, and .agent/iteration-log.md

### Task 1: Add append-only D1 storage

**Files:**

- Create: migrations/0016_quantitative_valuations.sql
- Modify: migrations/migrations.test.ts

- [ ] **Step 1: Add a failing migration test.**

~~~ts
test("quantitative valuation migration creates audit tables", () => {
  const db = new DatabaseSync(":memory:");
  expect(() => db.exec(readMigration("0016_quantitative_valuations.sql"))).not.toThrow();
  for (const table of [
    "valuation_source_snapshots",
    "valuation_forecast_versions",
    "valuation_assumption_values",
    "valuation_model_results",
    "valuation_actual_reviews",
  ]) expect(tableColumns(db, table).size).toBeGreaterThan(0);
  expect(tableColumns(db, "valuation_forecast_versions")).toContain("parent_version_id");
  expect(indexNames(db, "valuation_forecast_versions")).toContain("idx_valuation_forecast_versions_run");
});
~~~

- [ ] **Step 2: Run the test.**

Run: npm test -- migrations/migrations.test.ts

Expected: FAIL because the migration file does not exist.

- [ ] **Step 3: Create the migration.**

~~~sql
CREATE TABLE IF NOT EXISTS valuation_source_snapshots (
  id TEXT PRIMARY KEY, user_key TEXT NOT NULL, research_item_id TEXT NOT NULL,
  market TEXT NOT NULL, as_of TEXT NOT NULL, payload_json TEXT NOT NULL,
  evidence_hash TEXT, content_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(user_key, research_item_id, content_hash)
);
CREATE TABLE IF NOT EXISTS valuation_forecast_versions (
  id TEXT PRIMARY KEY, user_key TEXT NOT NULL, valuation_run_id TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL,
  parent_version_id TEXT, archetype TEXT NOT NULL, method TEXT NOT NULL,
  horizon_years INTEGER NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(valuation_run_id, version)
);
CREATE TABLE IF NOT EXISTS valuation_assumption_values (
  id TEXT PRIMARY KEY, version_id TEXT NOT NULL, key TEXT NOT NULL, scenario TEXT NOT NULL,
  forecast_year INTEGER, value REAL NOT NULL, unit TEXT NOT NULL, origin TEXT NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0, confidence REAL, evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  explanation TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS valuation_model_results (
  id TEXT PRIMARY KEY, version_id TEXT NOT NULL, model_key TEXT NOT NULL, weight REAL,
  payload_json TEXT NOT NULL, calculation_hash TEXT NOT NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, UNIQUE(version_id, model_key)
);
CREATE TABLE IF NOT EXISTS valuation_actual_reviews (
  id TEXT PRIMARY KEY, version_id TEXT NOT NULL, metric_key TEXT NOT NULL,
  forecast_year INTEGER NOT NULL, forecast_value REAL NOT NULL, actual_value REAL NOT NULL,
  absolute_error REAL NOT NULL, percentage_error REAL, reviewed_at TEXT NOT NULL,
  UNIQUE(version_id, metric_key, forecast_year)
);
CREATE INDEX IF NOT EXISTS idx_valuation_forecast_versions_run
  ON valuation_forecast_versions (user_key, valuation_run_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_valuation_source_snapshots_item
  ON valuation_source_snapshots (user_key, research_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_valuation_assumption_values_version
  ON valuation_assumption_values (version_id, key, scenario, forecast_year);
~~~

- [ ] **Step 4: Verify and commit.**

Run: npm test -- migrations/migrations.test.ts && git diff --check

Expected: PASS with no whitespace errors.

~~~bash
git add migrations/0016_quantitative_valuations.sql migrations/migrations.test.ts
git commit -m "feat: add quantitative valuation storage"
~~~

### Task 2: Establish one deterministic shared contract

**Files:**

- Create: src/shared/quantitative-valuation.ts
- Create: src/shared/quantitative-valuation.test.ts
- Modify: src/shared/valuation.ts
- Modify: functions/_shared/valuation-engine.ts

- [ ] **Step 1: Write failing calculation and validation tests.**

~~~ts
test("user overrides lock the auto-filled value", () => {
  expect(withUserOverride(assumption(0.08), 0.12)).toMatchObject({
    value: 0.12, origin: "user", locked: true,
  });
});
test("rejects terminal growth at or above WACC", () => {
  expect(() => validateQuantitativeDraft(rateFixture(0.08, 0.08))).toThrow("WACC 必须高于永续增长率");
});
test("calculates five forecast years and a finite per-share result", () => {
  const result = calculateOperatingValuation(operatingFixture());
  expect(result.forecastRows).toHaveLength(5);
  expect(result.scenarios.find((x) => x.scenario === "base")?.perShareValue).toBeGreaterThan(0);
});
~~~

- [ ] **Step 2: Run the test.**

Run: npm test -- src/shared/quantitative-valuation.test.ts

Expected: FAIL with a missing-module error.

- [ ] **Step 3: Implement shared types and helpers.**

~~~ts
export type QuantitativeOrigin = "provider" | "formula" | "ai" | "user";
export type QuantitativeScenario = "bear" | "base" | "bull";
export type EditableAssumption = {
  key: string; scenario: QuantitativeScenario; value: number; unit: "%" | "x" | "money";
  origin: QuantitativeOrigin; locked: boolean; confidence?: number; evidenceRefs: string[];
  explanation?: string; forecastYear?: number;
};
export type QuantitativeDraft = {
  runId: string; sourceSnapshotId: string; market: "A股"; asOf: string;
  archetype: CompanyArchetype; method: ValuationMethod; currentPrice?: number;
  assumptions: EditableAssumption[];
};
export function withUserOverride(base: EditableAssumption, value: number): EditableAssumption {
  return { ...base, value, origin: "user", locked: true };
}
export function validateQuantitativeDraft(draft: QuantitativeDraft) {
  const lookup = (key: string) => draft.assumptions.find((x) => x.key === key && x.scenario === "base")?.value;
  const wacc = lookup("discountRate"), growth = lookup("terminalGrowthRate");
  if (!Number.isFinite(wacc) || !Number.isFinite(growth) || wacc! <= growth!) throw new Error("WACC 必须高于永续增长率。");
}
~~~

Move the DCF, residual-income, cyclical, and sensitivity formulas from functions/_shared/valuation-engine.ts into this browser-safe file without changing formula semantics. Add calculateQuantitativeDraft, aggregateModelRange, and calculateActualReview. Re-export legacy names from valuation-engine.ts so current tests retain their imports. Add optional quantitativeVersionId, sourceSnapshotId, warnings, modelResults, and actualReviews fields to ValuationResult without invalidating legacy JSON.

- [ ] **Step 4: Verify and commit.**

Run: npm test -- src/shared/quantitative-valuation.test.ts functions/_shared/valuation-runner.test.ts && npm run typecheck:functions

Expected: PASS.

~~~bash
git add src/shared/quantitative-valuation.ts src/shared/quantitative-valuation.test.ts src/shared/valuation.ts functions/_shared/valuation-engine.ts
git commit -m "feat: share deterministic valuation calculations"
~~~

### Task 3: Generate sourced A-share baseline drafts

**Files:**

- Create: functions/_shared/quantitative-valuation-draft.ts
- Create: functions/_shared/quantitative-valuation-draft.test.ts

- [ ] **Step 1: Write failing source and baseline tests.**

~~~ts
test("creates a formula-backed A-share baseline from annual evidence", () => {
  const baseline = createQuantitativeBaseline(aShareEvidenceFixture(), operatingRunFixture());
  expect(baseline.draft.market).toBe("A股");
  expect(baseline.draft.assumptions.find((x) => x.key === "revenueGrowth" && x.scenario === "base"))
    .toMatchObject({ origin: "formula", locked: false });
});
test("rejects non A-share companies", () => {
  expect(() => createQuantitativeBaseline(hkEvidenceFixture(), operatingRunFixture())).toThrow("仅支持 A 股公司");
});
~~~

- [ ] **Step 2: Run the test.**

Run: npm test -- functions/_shared/quantitative-valuation-draft.test.ts

Expected: FAIL with a missing-module error.

- [ ] **Step 3: Implement eligibility, snapshot, and baseline.**

~~~ts
export function assertAshare(market: unknown, ticker: unknown) {
  const m = String(market ?? "").replace(/\s/g, "").toUpperCase();
  if (!/A股|沪A|深A|创业板|科创板|SH-A|SZ-A|ASTOCK/.test(m) || !/^\d{6}$/.test(String(ticker ?? ""))) {
    throw new Error("仅支持 A 股公司创建可编辑量化估值。");
  }
}
export function growthTriple(values: number[]) {
  const xs = values.filter((x) => Number.isFinite(x) && x > 0);
  const base = xs.length >= 2 ? Math.pow(xs.at(-1)! / xs[0], 1 / (xs.length - 1)) - 1 : 0.07;
  return { bear: Math.max(-0.1, base - 0.04), base, bull: Math.min(0.35, base + 0.04) };
}
~~~

Read annual history only from CompanyEvidencePackage.stableFacts.financialTenYear.rows and quotes only from freshSignals.quote. Preserve fiscal-year labels, source references, timestamps, evidence hash, and raw normalized values in the snapshot. Generate revenue growth, EBIT margin, capex, working capital, tax, WACC, terminal growth, net debt, and shares. Missing history uses documented fallback plus a warning; it never fabricates a precise source value.

- [ ] **Step 4: Verify and commit.**

Run: npm test -- functions/_shared/quantitative-valuation-draft.test.ts functions/_shared/company-evidence.test.ts

Expected: PASS.

~~~bash
git add functions/_shared/quantitative-valuation-draft.ts functions/_shared/quantitative-valuation-draft.test.ts
git commit -m "feat: derive A-share valuation baselines"
~~~

### Task 4: Persist versions and seed them from queued valuations

**Files:**

- Modify: functions/_shared/research-workbench-db.ts
- Create: functions/_shared/quantitative-valuation-db.test.ts
- Modify: functions/_shared/valuation-runner.ts
- Modify: functions/_shared/valuation-runner.test.ts

- [ ] **Step 1: Write a failing immutable-version test.**

~~~ts
test("edited save creates version two while retaining version one", async () => {
  const first = await createQuantitativeVersion(db, seededVersion({ createdBy: "baseline" }));
  const second = await createQuantitativeVersion(db, seededVersion({ parentVersionId: first.id, createdBy: "user", revenueGrowth: 0.12 }));
  expect(second.version).toBe(2);
  expect((await listQuantitativeVersions(db, "user-a", first.runId)).map((x) => x.version)).toEqual([2, 1]);
});
~~~

- [ ] **Step 2: Run the test.**

Run: npm test -- functions/_shared/quantitative-valuation-db.test.ts

Expected: FAIL because persistence helpers do not exist.

- [ ] **Step 3: Add database helpers.**

Implement createOrReadValuationSourceSnapshot, createQuantitativeVersion, readQuantitativeWorkspace, listQuantitativeVersions, and writeActualReviews. Every read filters user_key. A version save inserts the parent and every child in one db.batch.

~~~ts
const insertVersion = db.prepare(
  "INSERT INTO valuation_forecast_versions " +
  "(id, user_key, valuation_run_id, source_snapshot_id, version, status, parent_version_id, archetype, method, horizon_years, created_by, created_at) " +
  "SELECT ?1, ?2, ?3, ?4, COALESCE(MAX(version), 0) + 1, 'saved', ?5, ?6, ?7, 5, ?8, ?9 " +
  "FROM valuation_forecast_versions WHERE valuation_run_id = ?3"
);
~~~

- [ ] **Step 4: Add a failing worker test then implementation.**

~~~ts
test("worker creates a source-backed initial quantitative version", async () => {
  await processValuationRun(env, "run-1");
  expect((await readQuantitativeWorkspace(db, "user-1", "run-1"))?.versions).toHaveLength(1);
});
~~~

In processValuationRun, build the baseline from the already-read evidence package, create/reuse the snapshot, calculate through the shared contract, write a createdBy baseline version, then call completeValuationRun with the version ID in result JSON. Keep claimValuationRun, R2 write, and failValuationRun semantics unchanged.

- [ ] **Step 5: Verify and commit.**

Run: npm test -- functions/_shared/quantitative-valuation-db.test.ts functions/_shared/valuation-runner.test.ts && npm run typecheck:functions

Expected: PASS.

~~~bash
git add functions/_shared/research-workbench-db.ts functions/_shared/quantitative-valuation-db.test.ts functions/_shared/valuation-runner.ts functions/_shared/valuation-runner.test.ts
git commit -m "feat: version quantitative valuation drafts"
~~~

### Task 5: Add authenticated read and save APIs

**Files:**

- Create: functions/api/valuation-workspace.ts
- Create: functions/api/valuation-workspace.test.ts
- Modify: functions/api/valuations.ts

- [ ] **Step 1: Write failing API tests.**

~~~ts
test("rejects invalid user saves", async () => {
  const response = await onRequestPost(contextFor({ runId: "run-1", parentVersionId: "v1", assumptions: invalidRateDraft.assumptions }));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: "WACC 必须高于永续增长率。" });
});
test("prevents a second user reading the first user's workspace", async () => {
  expect((await onRequestGet(contextFor({}, "other-user"))).status).toBe(404);
});
~~~

- [ ] **Step 2: Run the test.**

Run: npm test -- functions/api/valuation-workspace.test.ts

Expected: FAIL with a missing-module error.

- [ ] **Step 3: Implement GET and POST.** GET reads a session-owned workspace by runId and returns 409 when the baseline is still processing. POST accepts runId, parentVersionId, and allowed assumptions; it rejects stale parent versions, applies user locks, validates, calculates server-side, writes a successor, and returns 201.

~~~ts
if (body?.parentVersionId !== workspace.versions[0]?.id) {
  return json({ error: "估值版本已更新，请刷新后再保存。" }, 409);
}
const draft = applyEditableAssumptions(workspace.versions[0].draft, body.assumptions);
validateQuantitativeDraft(draft);
const result = calculateQuantitativeDraft(draft);
~~~

- [ ] **Step 4: Gate new queued runs.** In functions/api/valuations.ts, resolve the selected research item/watchlist and reject industry, US, Hong Kong, and unresolved listings before queue send with 400 and the message 仅支持已加入研究队列的 A 股公司。

- [ ] **Step 5: Verify and commit.**

Run: npm test -- functions/api/valuation-workspace.test.ts && npm run typecheck:functions

Expected: PASS.

~~~bash
git add functions/api/valuation-workspace.ts functions/api/valuation-workspace.test.ts functions/api/valuations.ts
git commit -m "feat: add valuation workspace API"
~~~

### Task 6: Record forecast review after evidence refresh

**Files:**

- Modify: functions/api/company-evidence-refresh.ts
- Modify: functions/_shared/research-workbench-db.ts
- Create: functions/_shared/quantitative-valuation-review.test.ts

- [ ] **Step 1: Write a failing review test.**

~~~ts
test("records revenue error for a matching reported fiscal year", () => {
  expect(buildActualReviews(savedVersion(120), evidenceWithRevenue(2026, 100)))
    .toContainEqual(expect.objectContaining({
      metricKey: "revenue", forecastYear: 2026, absoluteError: 20, percentageError: 0.2,
    }));
});
~~~

- [ ] **Step 2: Run the test.**

Run: npm test -- functions/_shared/quantitative-valuation-review.test.ts

Expected: FAIL because the actual-review builder is absent.

- [ ] **Step 3: Implement matching and refresh integration.** Match only finite annual revenue, EBIT, and FCF fields with exact fiscal years. Never substitute a TTM value. After fetchAndStoreCompanyEvidence succeeds, build and write reviews. Catch review failures separately, retain evidence-refresh success, and include review failure diagnostics in the endpoint response.

- [ ] **Step 4: Verify and commit.**

Run: npm test -- functions/_shared/quantitative-valuation-review.test.ts functions/_shared/company-evidence.test.ts

Expected: PASS.

~~~bash
git add functions/api/company-evidence-refresh.ts functions/_shared/research-workbench-db.ts functions/_shared/quantitative-valuation-review.test.ts
git commit -m "feat: review forecasts against actual results"
~~~

### Task 7: Implement typed editor state and workspace UI

**Files:**

- Modify: src/api.ts
- Create: src/quantitative-valuation-state.ts
- Create: src/quantitative-valuation-state.test.ts
- Create: src/QuantitativeValuationWorkspace.tsx

- [ ] **Step 1: Write a failing editor-state test.**

~~~ts
test("parses a percentage and creates a user lock", () => {
  const next = applyDraftEdit(baseDraft(), { key: "revenueGrowth", scenario: "base", rawValue: "12.5" });
  expect(findAssumption(next, "revenueGrowth", "base")).toMatchObject({
    value: 0.125, origin: "user", locked: true,
  });
});
~~~

- [ ] **Step 2: Run the test.**

Run: npm test -- src/quantitative-valuation-state.test.ts

Expected: FAIL with a missing-module error.

- [ ] **Step 3: Add client API calls and state helpers.**

~~~ts
export async function saveQuantitativeValuationWorkspace(input: {
  runId: string; parentVersionId: string; assumptions: EditableAssumption[];
}) {
  const response = await fetch("/api/valuation-workspace", {
    method: "POST", headers: { "content-type": "application/json" },
    credentials: "include", body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error((await readError(response)) || "估值保存失败。");
  return (await response.json()) as {
    workspace: QuantitativeValuationWorkspace; version: QuantitativeValuationVersion;
  };
}
~~~

Export applyDraftEdit, clearDraftEdit, findAssumption, draftWarnings, and simpleEditorFields. All calculation stays in the shared contract.

- [ ] **Step 4: Compose the workspace.**

~~~tsx
<section className="quant-valuation-workspace" aria-label={run.title + " 量化估值"}>
  <SnapshotHeader workspace={workspace} />
  <ForecastEditor draft={draft} mode={mode} onEdit={handleEdit} onClear={handleClear} />
  <ValuationResults currentPrice={workspace.snapshot.currentPrice} result={preview} />
  <SensitivityAndRisks sensitivity={preview.sensitivity} warnings={draftWarnings(draft)} />
  <ValuationVersionHistory versions={workspace.versions} reviews={workspace.actualReviews} />
</section>
~~~

Default to simple mode with bear/base/bull tabs and fields for revenue growth, EBIT margin, capex, working capital, tax, WACC, terminal growth, net debt, and shares. Show five-year row overrides only after advanced mode. Disable save for error warnings and reload on 409 conflict.

- [ ] **Step 5: Verify and commit.**

Run: npm test -- src/quantitative-valuation-state.test.ts src/api.test.ts && npm run build

Expected: PASS.

~~~bash
git add src/api.ts src/quantitative-valuation-state.ts src/quantitative-valuation-state.test.ts src/QuantitativeValuationWorkspace.tsx
git commit -m "feat: add editable valuation forecast editor"
~~~

### Task 8: Integrate into the laboratory and verify the full flow

**Files:**

- Modify: src/ValuationLabView.tsx
- Modify: src/valuation-state.ts
- Modify: src/valuation-state.test.ts
- Modify: src/App.css
- Modify: README.md
- Modify: .agent/iteration-log.md

- [ ] **Step 1: Write a failing display-mode test.**

~~~ts
test("opens only completed quantitative runs in the workspace", () => {
  expect(valuationDisplayMode(quantitativeCompletedRun())).toBe("workspace");
  expect(valuationDisplayMode(legacyCompletedRun())).toBe("card");
  expect(valuationDisplayMode(queuedRun())).toBe("card");
});
~~~

- [ ] **Step 2: Run the test.**

Run: npm test -- src/valuation-state.test.ts

Expected: FAIL because valuationDisplayMode is absent.

- [ ] **Step 3: Integrate without breaking existing history UI.**

~~~tsx
{selectedWorkspaceRun ? (
  <QuantitativeValuationWorkspace
    run={selectedWorkspaceRun}
    onSaved={(workspace) => setRuns((current) => mergeWorkspaceSummary(current, workspace))}
  />
) : null}
~~~

Keep the picker, queue polling, retry state, sort pills, historic cards, trend, and two-version comparison. Legacy, queued, and failed runs remain cards.

- [ ] **Step 4: Add token-based responsive CSS.** Add quant-valuation-workspace, quant-snapshot, quant-editor-grid, quant-scenario-tabs, quant-warning, quant-results-grid, quant-sensitivity-table, quant-version-timeline, and quant-review-table. Use only existing theme variables. Below 760px stack editor/results and use valuation-table-wrap for tables.

- [ ] **Step 5: Document and run verification.** Document A-share-only scope, five-year auto-fill, manual-lock priority, and deterministic formulas. Record create → edit → save successor → refresh evidence → actual review in the iteration log.

Run: npm test

Expected: all Vitest suites PASS.

Run: npm run lint && npm run typecheck:functions && npm run build

Expected: all commands exit 0.

- [ ] **Step 6: Browser QA.** Run npm run pages:dev; log in using an existing fixed account; inspect 1440px and 390px widths. Verify baseline loading, simple and advanced modes, invalid WACC warning, saving, comparison, legacy card rendering, and actual-review panel without console errors. Stop the server after the check.

- [ ] **Step 7: Commit release evidence.**

~~~bash
git diff --check
git status --short
git add src/ValuationLabView.tsx src/valuation-state.ts src/valuation-state.test.ts src/App.css README.md .agent/iteration-log.md
git commit -m "feat: ship A-share quantitative valuation workspace"
~~~

## Plan self-review

- Spec coverage: Tasks 1–4 implement snapshots, immutable versions, auto-filled baselines, deterministic models, validation, and legacy compatibility. Tasks 5–8 implement authorization, A-share gating, manual overrides, simple/advanced UI, sensitivity, versioning, actual review, documentation, and full verification.
- Placeholder scan: every task names files, tests, commands, expected outcomes, and required behaviour.
- Type consistency: QuantitativeDraft and EditableAssumption are defined before worker, API, state, and UI tasks. runId, sourceSnapshotId, and parentVersionId retain one name throughout.

