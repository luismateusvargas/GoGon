# Show when notification delivery stops progressing

Status: ready
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
