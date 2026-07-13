# Radar Job Publication Safety Design

## Problem

Radar analysis jobs are stored in Workers KV. The website treats a queued or running job as retryable after 20 minutes, while GitHub Actions serializes only identical `job_id` values. If an older workflow finishes after a retry has created a newer job, the older workflow unconditionally replaces both `radar-scan:v2:latest` and `radar-analysis:job:latest`. The same unconditional write occurs on failure. KV does not provide the compare-and-swap operation needed to make those writes safe.

Completed radar jobs also contain model token usage, but `readLatestRadarJob` drops that nested value while normalizing KV data, so admin diagnostics cannot display it.

## Chosen Design

Use a one-row D1 table as the authoritative current radar-job state. Every attempt receives a random run token. State transitions use conditional SQL updates on both `job_id` and `run_token`; only the current run may move from `queued` to `running`, claim `publishing` or `failing`, and finish. `publishing` and `failing` block retries while KV publication is in progress.

The website atomically queues a new attempt only when the current row is terminal or stale. A protected Pages Function starts jobs and accepts completion or failure callbacks. It claims the D1 state before writing global KV keys, so a superseded callback receives HTTP 409 before it can publish. GitHub Actions calls this API instead of writing global radar/job KV keys directly. The workflow uses a repository-wide radar concurrency group to avoid simultaneous paid model runs.

Existing per-job and latest-job KV records remain as presentation and compatibility copies. D1 is authoritative for current job status; the radar result itself remains in KV. Existing deployments without a D1 state row fall back to the latest KV job for reads until the first new job is queued.

## Interfaces

- `queueRadarAnalysisJob(db, evidenceHash)` returns the public job, a run token only for a newly created attempt, and whether this caller won the queue operation.
- `startRadarAnalysisJobRun(db, jobId, runToken)` conditionally changes `queued` to `running`.
- `claimRadarAnalysisJobPublication(...)` and `claimRadarAnalysisJobFailure(...)` conditionally reserve the current attempt before any KV write.
- `completeRadarAnalysisJobRun(...)` and `finishRadarAnalysisJobFailure(...)` close only their matching reserved state.
- `POST /api/radar-analysis-job` accepts `start`, `complete`, or `fail` from the protected workflow client.
- Workflow dispatch includes both `job_id` and `run_token`.

## Validation And Failure Handling

The callback endpoint validates job IDs, UUID run tokens, completion job metadata, radar cache version, and matching generated timestamps before claiming publication. Authentication uses `RADAR_ANALYSIS_WORKER_TOKEN`, falling back to the already shared `TEMPLATE_ANALYSIS_WORKER_TOKEN` so rollout requires no new mandatory secret.

If a callback is superseded, it returns 409 and performs no KV write. If KV publication fails after a successful claim, the D1 attempt is closed as failed so the UI can retry. Dispatch failures use the same conditional failure path and cannot overwrite a newer attempt.

## Test Strategy

- Migration test proves the singleton state table and run-token fields exist.
- Shared-state tests prove queue contention, stale replacement, and conditional transitions.
- API tests prove stale callbacks cannot write KV and current callbacks publish exactly once.
- Workflow/client tests prove run-token propagation, global serialization, stale 409 handling, and removal of direct global KV publication.
- Radar API tests prove repeated requests reuse the D1 current job and dispatch includes the run token.
- A normalization test proves token usage survives reads and reaches diagnostics.
