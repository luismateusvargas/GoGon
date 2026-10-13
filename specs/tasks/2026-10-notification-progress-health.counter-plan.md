# Show when notification delivery stops progressing — counter-plan

Original task spec: specs/tasks/2026-10-notification-progress-health.md
Review evidence: 2026-10-13 independent review of 198c040..42cb44f and injected health-report failure
Status: ready

## Confirmed failures

- **H1, AC-1 operational health:** `healthCheck.mjs:72-78` catches a delivery progress read failure, sets `delivery: 'unknown'`, and leaves `status: 'ok'`. The subsequent `SELECT 1` checks only MySQL connectivity; it cannot establish that the outbox query or dispatcher is usable. Reproduction: `healthReport({tasksStatus: () => [], database: async () => {}, delivery: async () => { throw Error('outbox query failed') }})` returns `{"status":"ok","delivery":"unknown"}`. The existing test at `tests/health-metrics/delivery-progress.test.mjs:119-121` asserts this behavior. The probe therefore reports healthy while it cannot assess notification delivery.

## Surgical corrections

- H1: Treat an unreadable delivery snapshot as an unhealthy or explicitly degraded probe outcome with a sanitized category. Preserve the minimal unauthenticated response and let a later successful read restore normal status. Do not expose SQL text or payloads.

## Acceptance and verification

| Finding | Targeted check and expected result |
| --- | --- |
| H1 | Inject a delivery snapshot failure while `SELECT 1` succeeds; `/health` does not return a healthy 200. Empty queues with a successful read still return 200, and owner detail remains redacted. |

Completion means H1 is fixed and health, metrics, and control-plane regression tests pass.

## Blockers

None.
