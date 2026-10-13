# Preserve claimed game alerts until Discord accepts them

Status: ready
Project: specs/project.yaml
Constitution: specs/constitution.yaml
Related domains: specs/game-monitors.spec.yaml, specs/discord-integration.spec.yaml, specs/data-storage.spec.yaml

## Outcome and non-goals

An event a monitor marks as processed remains eligible for delivery after a webhook error or container restart. This spec covers event handoff and replay, not the queue deadline or health display.

## Current contracts and impact

- `app_modules/Crates.js` and `app_modules/GuildMessages.js` save new IDs in MySQL before calling non-awaitable notification helpers. `BountyBoard.js` follows the same claim-first pattern; other monitors must be inventoried before implementation. `utils.js` stores batches and the send queue only in memory and removes non-429 failures. A failed or stalled send can therefore permanently suppress an already claimed alert.
- MySQL 8.4 is the live store. Existing monitor dedupe keys and owner account switch semantics must remain compatible.

## Acceptance criteria

- AC-1: Given a new event, its dedupe identity and pending notification are committed atomically before the monitor considers it handled. Restarting between claim and Discord acceptance leaves one recoverable pending record.
- AC-2: Given a retryable delivery failure, the record remains pending with bounded attempt metadata; after recovery it is sent without re-reading an unavailable game archive. Given permanent failure, the record is visible for owner action and does not block unrelated notifications.
- AC-3: Given Discord accepts a notification, the record becomes delivered. Replay may produce at most the explicitly documented duplicate window between Discord acceptance and MySQL acknowledgment; no promise of exactly-once external delivery is made.
- AC-4: Given an account switch, alerts retain the account identity they came from and cannot be sent under the wrong active profile. Existing processed ID history stays readable during migration.

## Design and ordered work

1. Inventory every monitor's dedupe-write and notification call path; identify per-event stable IDs and account scope. Document any monitor without a stable ID before changing it.
2. Add an ordered, repeatable MySQL migration for a notification outbox with event key, account scope, destination setting key (not the secret URL), safe payload, state, attempts, next-attempt time, and timestamps. Keep secrets out of rows and logs.
3. Introduce a transaction-backed claim-and-enqueue API in the data layer. Migrate monitors one at a time, preserving their existing dedupe behavior and alert format. Resolve the live webhook setting at dispatch time.
4. Have the delivery worker acknowledge the outbox after Discord success and expose retryable/permanent outcomes from the recovery spec. Replay pending work at startup with existing global Discord spacing. Keep failed records inspectable to the owner without payload or secret exposure.
5. Add fake-MySQL and MySQL 8.4 tests for claim atomicity, restart replay, account switch, permanent failure isolation, and duplicate acceptance window.

## Verification

| Criterion | Check and expected result |
| --- | --- |
| AC-1 | Crash simulation after commit leaves one pending row; repeat claim does not duplicate it. |
| AC-2 | Offline Discord and recovery tests retain then deliver pending rows; permanent failure stays inspectable. |
| AC-3 | Inject failure after Discord acceptance and before acknowledgment; replay behavior matches the documented duplicate window. |
| AC-4 | Run monitor and account-switch tests on fake and real MySQL; account-scoped work is not mixed. |

## Change safety

Migration is additive; do not delete old dedupe keys. Deploy schema before monitor cutover and keep new dispatch compatible with prior rows. Rollback the image without dropping the outbox table; preserve pending rows for a later recovery. Do not bulk replay historical processed IDs because their payloads and delivery outcomes are unknown.

## Open decisions and sources

None blocks design; implementation inventory may reveal monitors with no stable event identity and should record them as scoped follow-up decisions. Depends on `2026-10-discord-delivery-recovery.md`. Sources: `app_modules/Crates.js`, `app_modules/GuildMessages.js`, `app_modules/BountyBoard.js`, `utils.js`, `_gg_data/migrations/`, `specs/game-monitors.spec.yaml`.
