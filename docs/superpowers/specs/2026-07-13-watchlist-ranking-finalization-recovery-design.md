# Watchlist Ranking Finalization Recovery Design

## Problem

The watchlist ranking callback claims a running attempt by replacing its run token with `finalizing:<run-token>`. If the subsequent completion update throws, the endpoint currently exits without recording a terminal state. The workflow's fallback callback still carries the original token, so it is rejected as stale and the UI can remain in `running` until the 20-minute stale timeout.

## Decision

Keep the existing D1 run-token state machine and add guarded recovery inside `POST /api/watchlist-ranking-job`.

After a successful claim, both the normal completion write and the explicit model-failure write run inside one protected block. If either throws, the endpoint attempts `writeWatchlistRankingFailure` with the claimed `finalizing` token and a generic persistence-failure message. A successful recovery returns HTTP 500 so the callback is truthfully reported as failed while the user-visible row is immediately `failed_retryable`. A conditional-update miss returns 409 because another run has superseded it. If recovery itself throws, the endpoint still returns a sanitized HTTP 500 rather than leaking an unhandled exception or database detail.

## Alternatives Rejected

- Rely on the existing stale timeout: preserves a misleading running state for up to 20 minutes.
- Replace callbacks with a Durable Object or transactional outbox: stronger coordination but disproportionate to one D1 terminal-write gap.
- Accept the original token during fallback: would weaken stale callback protection after the run has been claimed.

## Compatibility

- No schema or environment-variable changes.
- Successful completions still return 200.
- Model failures still use their current `failed_retryable` path and return 200 when persisted.
- Superseded callbacks still return 409.
- Stored internal persistence errors use a fixed Chinese message and do not expose SQL or provider details.

## Verification

- Inject a completion-update exception and assert the recovery update uses `finalizing:<run-token>` and the response is a sanitized 500.
- Inject failures in both the completion and recovery updates and assert the endpoint returns a sanitized 500 rather than rejecting.
- Re-run callback tests, the full test suite, lint, Functions typecheck, production build, dependency audit, CI, Cloudflare deployment, and a non-mutating production callback authentication smoke test.
