# Show when notification delivery stops progressing

Status: implemented (pending review)
Project: specs/project.yaml
Constitution: specs/constitution.yaml
Related domains: specs/health-metrics.spec.yaml, specs/discord-integration.spec.yaml, specs/task-engine.spec.yaml, specs/control-plane.spec.yaml

## Outcome and non-goals

The owner can distinguish an idle system from a delivery backlog or a stuck sender using safe health and metrics, while the container health check detects a sustained stalled backlog.

## Current contracts and impact

- `metrics.mjs` defines Discord counters, but `incrementMetric()` has no callers, so the displayed Discord numbers stay zero. `healthCheck.mjs` checks task counts and MySQL only. `control-plane/server.mjs` exposes authenticated `/api/health`, `/api/metrics`, and module `lastRun`, while the unauthenticated loopback `/health` has only a small summary.
- `app_modules/core.js` gates routine `LOG()` behind `GG_DEBUG`; a stuck delivery request produces no warning or error. Do not log or reveal raw webhook URLs, Discord payloads, game messages, tokens, or cookies.

## Acceptance criteria

- AC-1: Given queued notifications with no completed attempt for longer than the defined progress threshold, the owner health API reports a delivery stall with queue age, attempt age, and sanitized outcome; the loopback health probe becomes unhealthy after the sustained threshold. An empty queue remains healthy even when no game events occur.
- AC-2: Given send, retry, timeout, rate limit, and permanent failure, authenticated metrics advance corresponding counters and expose last progress time and pending count. Metrics never include a webhook URL or message body.
- AC-3: Given an enabled monitor that has not completed within its expected interval plus a documented grace period, owner state shows it overdue; a disabled or intentionally paused monitor is not reported overdue.
- AC-4: Given a delivery stall or recovery, a rate-bounded WARNING or INFO event records safe category, age, and queue count. Repeated health polls do not flood logs.

## Design and ordered work

1. Add a read-only delivery progress snapshot from the queue/outbox worker: pending count, oldest pending age, current attempt age, last attempt completion, last success, and sanitized failure category. Update metrics at the point of actual outcomes, not at enqueue.
2. Extend `metrics.mjs`, `healthCheck.mjs`, and the authenticated control-plane state to show progress and classify idle, backlog, stalled, and recovered states. Keep the existing loopback response minimal and free of configuration or payload data.
3. Derive monitor overdue state from `getTasksStatus()` interval and `lastRun`, respecting enabled, paused, and in-flight states. Set and document a finite grace rule in code and tests.
4. Add deterministic tests for quiet idle time, stalled pending work, recovery, disabled and paused modules, and redaction. Check that Docker's `/health` semantics still permit normal startup and a genuinely idle game period.

## Verification

| Criterion | Check and expected result |
| --- | --- |
| AC-1 | `npm test` health fixture: pending stall returns unhealthy, empty queue stays healthy. |
| AC-2 | Delivery fixture drives all outcomes; `/api/metrics` changes and contains no secrets. |
| AC-3 | Fake-clock task state tests distinguish overdue from disabled, paused, and running. |
| AC-4 | Repeated probe tests show one bounded warning and one recovery event, both redacted. |

## Change safety

No schema change in this spec. Add fields compatibly to existing JSON; keep prior status and route contracts. Roll out after delivery recovery and outbox so progress reflects persisted work. Observe the first deployment for false unhealthy states before relying on container restart policy. Existing `docker compose` restart policy may restart an unhealthy container only if another operator acts; document alerting separately if needed.

## Open decisions and sources

None blocks design. Dependencies: `2026-10-discord-delivery-recovery.md`, then `2026-10-notification-outbox.md`. Sources: `metrics.mjs`, `healthCheck.mjs`, `engine.js`, `control-plane/server.mjs`, `compose.yaml`, `tests/health-metrics/probe.test.mjs`.

## Implementation notes (2026-10-13)

Branch `fix/notification-outbox`, on top of the outbox implementation (cce88c1). Baseline checkpoint 198c040.

### Decisions

- **Progress means a completed attempt.** Any finished send attempt (accepted, or failed by timeout, network error, 4xx/5xx, or 429) counts as progress. A sender that keeps failing shows as a `backlog` with a failure category, not as a stuck sender. Only *due* work counts toward a stall: messages waiting for a 429 pause, a retry delay, or the batch window, and outbox rows in backoff or held for another account, are not due.
- **Thresholds** (`webhooks.js`): `DELIVERY_STALL_AFTER` 5 min (owner reports `stalled`, one WARN); `DELIVERY_UNHEALTHY_AFTER` 15 min (loopback probe 503); `DELIVERY_RECOVERED_WINDOW` 15 min. A live queue completes an attempt at least every 75 s while work is due (60 s retry-after cap + 15 s deadline). With the Compose healthcheck (30 s × 3 retries), the container is marked unhealthy about 16.5 min after the last completed attempt.
- **Replayed outbox rows** keep an old `next_attempt_at`, so their due time is clamped to when the dispatcher started serving the active account (process start or account switch). Normal startup and account switches therefore start with a fresh stall clock.
- **Pending count** = messages in the in-memory queue and batch windows + due outbox rows not yet handed to that queue. Rows already in the queue are counted once.
- **Overdue rule** (`app_modules/taskHealth.js`): overdue when `now > expected start + max(interval, 2 min)`. Expected start is the engine's new `nextRunAt`, or else the end of `lastRun` + interval; `nextRunAt` keeps a mid-cycle interval change from producing a false overdue. A module is never overdue when it is disabled or stopped, when the engine is paused, while a run is in flight, or before its first run finishes. Overdue is shown to the owner only; it does not change the probe status.
- **Logging:** `INFO` is added to `app_modules/core.js` and is always printed, so the recovery event is visible with `GG_DEBUG=0`. Stall and recovery are logged only on transitions. Concurrent polls cannot log twice. `app.mjs` also checks every 60 s, so a stall is logged even when nothing polls health.
- **Counters** live in `app_modules/metricsStore.js`, which has no imports, so `utils.js` can record outcomes without an import cycle through `metrics.mjs` → `engine.js`. `metrics.mjs` still exports `incrementMetric`. `getMetrics()` is now async, and the control plane awaits it.

### Criterion → check

| Criterion | Tests |
| --- | --- |
| AC-1 | `tests/health-metrics/delivery-progress.test.mjs` (idle, draining backlog, not-due work, stall at 5 min, probe 503 only after 15 min with a minimal body, owner detail); `tests/health-metrics/probe.test.mjs` (empty queue `delivery: 'idle'`, 200); `tests/discord-integration/outbox.test.mjs` progress test (due count, in-flight exclusion, backoff, held account, replay clamp) |
| AC-2 | `tests/health-metrics/metrics.test.mjs` drives the real queue through send, batch, timeout + retry + drop, 429, 4xx, and 5xx retry; checks counters, `lastProgressAt`, pending, failure category, and that no URL or body is present. The outbox progress test checks the outbox counters. `tests/control-plane/server.test.mjs` checks async `/api/metrics` (200 and 500) |
| AC-3 | `tests/task-engine/scheduling.test.mjs` progress-health tests (real engine, fake clock: `nextRunAt`, grace boundary, disabled, paused, running, first run, stopped); control-plane state shows `overdue` |
| AC-4 | `tests/health-metrics/delivery-progress.test.mjs` AC-4: 42 polls in 21 concurrent pairs → one WARN and one INFO, both redacted; `recovered` returns to `idle` after the window; a failed read logs nothing |

### Remaining release checks

Not run locally (no Node 22 or Docker here): the Node 22.20 suite, the MySQL 8.4 CI job, and `docker compose config` / the image build. After deployment, watch for false `stalled`/unhealthy states before relying on the restart policy.
