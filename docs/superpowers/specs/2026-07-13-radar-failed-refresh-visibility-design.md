# Radar Failed Refresh Visibility Design

## Problem

The radar page keeps the last successful scan visible while a background refresh runs. When that job ends with `status: "failed"`, both the initial load path and the polling path currently treat the cached radar as an ordinary ready result. They discard `job.message`, and the view labels the result as `复用稳定扫描`. Users can therefore mistake a failed refresh for a successful cache reuse and receive no reason or retry cue.

## Decision

Add a pure radar-result state resolver in `src/radar-ui.ts` and use it from both result-handling paths in `src/App.tsx`.

The resolver receives the API result and whether a radar was already visible. It returns the next `RadarPhase` and user-visible error text:

- `queued` or `running`: keep the current loading/refreshing behavior.
- `failed` with a visible radar: keep the radar, use phase `ready`, and expose `job.message` or a fixed retained-scan fallback.
- `failed` without a radar: use phase `error` and expose `job.message` or a fixed unavailable fallback.
- Other terminal results: preserve the existing ready/error and warning behavior.

Add a separate pure status-label helper for `RadarView`. A failed job with cached radar displays `刷新失败，已保留上次扫描`; running and successful cached/new scans retain their current labels. Because failed jobs are not loading, the existing `雷达扫描` button remains enabled as the retry action.

## Alternatives Rejected

- Add inline failed-job checks in both `loadRadar` and the polling callback: smallest diff, but duplicates the state rules that already drifted.
- Add React component-test infrastructure for this change: useful eventually, but unnecessary when the behavior can be isolated behind pure functions and the repository currently has no `RadarView` component harness.
- Remove the cached radar on refresh failure: loses useful last-known-good information and contradicts the existing retained-result experience.

## Compatibility

- No API, database, workflow, environment-variable, or dependency changes.
- Successful, queued, and running radar behavior remains unchanged.
- A failed refresh never replaces the last successful radar.
- Server-provided failure text is displayed when available; otherwise the UI uses fixed Chinese fallback copy.

## Verification

- Unit-test failed jobs with and without an existing radar.
- Unit-test running, successful cached, and successful new-scan states to prevent regressions.
- Run the focused radar/App tests, full test suite, lint, Functions typecheck, production build, dependency audit, GitHub Actions, Cloudflare deployment, and production radar read smoke tests.
