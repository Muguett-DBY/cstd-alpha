# A-Share Quantitative Valuation System Design

## Purpose

Turn the existing valuation laboratory into an auditable, user-editable quantitative valuation workflow for A-share companies that have already been added to research. The system must help a non-specialist begin with a credible baseline while retaining deterministic calculations, input provenance, and repeatable valuation versions.

## Scope

- Only A-share company research items are eligible for the new manual forecasting workflow.
- The default forecasting horizon is five explicit fiscal years plus a terminal value.
- The system generates a baseline forecast from the latest verified historical financials and existing company evidence.
- Users can change model assumptions and, in advanced mode, override values for individual forecast years.
- Every saved valuation preserves its source snapshot, assumptions, calculation output, and user modifications.
- The laboratory presents scenario values, cross-model ranges, sensitivity analysis, comparison between saved versions, and forecast-versus-actual review after new financials arrive.

## Non-goals

- Do not claim to predict a future share price with certainty.
- Do not introduce an opaque machine-learning price model in the first release.
- Do not accept arbitrary unversioned spreadsheet uploads as a source of truth.
- Do not extend manual forecasting to Hong Kong or US equities in this release.
- Do not replace existing research reports, watchlists, or the current asynchronous valuation-run infrastructure.

## Product Principle

The workflow is **auto-fill first, user judgement second, formula calculation last**. AI may propose and explain assumptions, but it never owns the final arithmetic. A user-entered value takes precedence over an automated value and remains locked until the user changes or clears it.

## User Flow

1. An administrator opens an A-share research item in the valuation laboratory.
2. The system resolves an as-of data snapshot: company identity, reporting period, price, share count, net debt, historic financials, evidence references, and source timestamps.
3. The system selects the company archetype and creates a five-year baseline forecast with bear, base, and bull scenarios.
4. The user reviews a compact driver panel, changes assumptions where needed, and may open advanced mode to override individual yearly values.
5. Input checks run immediately. Valid changes recalculate all models in the browser; saving creates an immutable valuation version on the server.
6. The results view presents model values, a weighted range, current-price upside/downside, sensitivity, risks, and the exact assumptions used.
7. On later reporting periods, the system compares saved forecasts with actuals and exposes forecast error by metric and year.

## Models and Routing

| Archetype | Primary method | Cross-check | Rationale |
| --- | --- | --- | --- |
| Operating company | FCFF DCF | EV/EBITDA or PE peer range | Value is driven by forecast operating cash flow. |
| Bank or insurer | Residual income / dividend discount | PB and sustainable ROE | Cash flow is not a reliable primary valuation basis. |
| Cyclical resource or capital-intensive company | Mid-cycle EBITDA or normalized earnings | EV/EBITDA, PB, replacement value where available | Spot-cycle profit should not be treated as permanent earnings. |

Existing route selection and deterministic DCF, residual-income, and mid-cycle calculations remain the calculation core. The release adds explicit forecast inputs, source snapshots, user overrides, and a consistent cross-check result. Model routing is visible and can be overridden only with a recorded reason.

## Forecast Baseline and Inputs

The baseline starts from verified reported values rather than language-model scale estimates. For an operating company, the system derives a starting range from historical trends, latest evidence, and sector defaults, then records the derivation in the assumption metadata.

The simple editor exposes only these drivers:

- Revenue growth
- EBIT margin
- Capital expenditure as a percentage of revenue
- Working-capital investment as a percentage of revenue
- Tax rate
- WACC
- Terminal growth rate
- Net debt and diluted shares outstanding

The advanced editor exposes a five-year forecast grid for revenue, EBIT margin, depreciation, capex, working-capital change, tax, and free cash flow. A row may inherit the scenario driver or receive a locked per-year override. The user never has to fill the grid to obtain a complete valuation.

For financials, the simple editor uses book value, ROE, payout ratio, cost of equity, and terminal growth. For cyclicals, it uses mid-cycle EBITDA, normalized net cash, selected valuation multiple, and optional replacement asset value.

## Data and Versioning

Add append-only storage around the existing `valuation_runs` record:

- `valuation_source_snapshots`: normalized reported inputs, market values, provider/source identifiers, publication dates, fetched time, and content hash.
- `valuation_forecast_versions`: valuation-run linkage, model route, horizon, source-snapshot identifier, status, editor identity, and timestamp.
- `valuation_assumption_values`: one row per assumption, scenario, forecast year where applicable, origin (`provider`, `formula`, `ai`, `user`), lock state, confidence, evidence references, and explanation.
- `valuation_model_results`: one row per version and model, including enterprise/equity/per-share value, weight, output range, calculation hash, and warnings.
- `valuation_actual_reviews`: matched reported values, forecast values, absolute/percentage error, and review status.

The denormalized result JSON on `valuation_runs` remains a fast read model for the current card UI. The normalized records are the authoritative audit trail. A saved version is immutable; edits create a successor version rather than overwriting history.

## Calculation and Validation Rules

- Use decimal-safe calculations and normalize all percentages to a single internal representation.
- Use reported fiscal periods, not calendar labels alone, and show the fiscal-year end date.
- Require positive, sourced diluted share count before publishing per-share value.
- Require WACC/cost of equity to exceed terminal growth; reject invalid terminal-value calculations.
- Warn when a user input falls outside configurable historic and peer ranges; do not silently replace a user value.
- Flag missing net debt, stale price, insufficient historical periods, negative terminal free cash flow, and an excessively wide scenario range.
- Keep the current three-scenario output and add a DCF sensitivity matrix for WACC and terminal growth.
- Do not create a combined target price when the primary model and cross-check differ beyond a configured tolerance; present the conflict and its drivers instead.

## Interface

The existing `ValuationLabView` remains the entry point and preserves its research-item picker, task state, history, and version comparison. Completed A-share runs gain a full-screen valuation workspace with five areas:

1. **Snapshot header**: company, period, price, archetype, models, freshness, and data warnings.
2. **Forecast editor**: simple driver cards by default, scenario tabs, evidence links, and advanced yearly overrides on demand.
3. **Valuation results**: primary and cross-check model values, weighted range, current-price comparison, and confidence/warning state.
4. **Sensitivity and risks**: WACC/terminal-growth matrix, key-driver impact, input-quality issues, and explicit invalidation conditions.
5. **Versions and review**: immutable version timeline, side-by-side comparison, and forecast accuracy once actuals exist.

The initial page must remain usable on a desktop without horizontal scrolling. On narrow screens the editor and results stack, while wide tables receive a contained scroll region. Existing theme variables and terminal-panel components remain the visual system.

## Backend Workflow

1. A request validates that the selected research item is an A-share company.
2. A background worker refreshes or reuses a data snapshot, selects a route, and creates baseline assumptions.
3. The API returns the editable draft and its source provenance.
4. A save request validates inputs, runs deterministic calculations server-side, persists an immutable version, and returns the rendered result.
5. When a later company evidence refresh contains a new reported period, a review worker matches it to relevant forecast versions and calculates forecast error.

The browser may perform an immediate preview with the same pure calculation helpers, but the server calculation is authoritative. Client and server share one TypeScript valuation-contract package and contract tests prove that they produce identical results for fixed inputs.

## Testing and Acceptance Criteria

- Unit tests cover source snapshot normalization, archetype routing, baseline range generation, lock precedence, every calculation method, invalid-input rules, and forecast-error calculations.
- Contract tests prove preview and server calculations match for operating, financial, and cyclical examples.
- API tests cover A-share eligibility, authorization, version immutability, invalid save rejection, and source provenance persistence.
- UI tests cover baseline loading, simple-driver edits, advanced override, scenario switching, warnings, saving, version comparison, and an empty/stale-data state.
- Migration tests prove all added tables and indexes apply to a clean D1 database.
- Regression checks retain the current queued valuation-task behavior and existing completed-run cards.

## Delivery Sequence

1. Establish shared valuation contracts, D1 migrations, snapshot/version persistence, and deterministic calculation validation.
2. Add the A-share baseline-data adapter and background draft generation while keeping the existing laboratory UI operational.
3. Add the forecast editor, client preview, server save, model results, and sensitivity view.
4. Add version comparison and forecast-versus-actual review.
5. Run migration, unit, contract, API, browser, build, and production-deployment checks before release.

## Decisions Made

- Market scope: A shares only.
- Forecast horizon: five explicit years plus terminal value.
- Default experience: auto-filled baseline, then user edits.
- User experience: simple mode first; advanced, per-year model controls are optional.
- Calculation policy: deterministic and auditable; AI is advisory only.
