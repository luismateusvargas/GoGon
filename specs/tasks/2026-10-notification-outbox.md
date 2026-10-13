# Preserve claimed game alerts until Discord accepts them

Status: implemented (pending review)
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

## Implementation notes (2026-10-13)

Branch `fix/notification-outbox`, stacked on `fix/discord-delivery-recovery` (c8226f4).

### Monitor inventory (step 1)

| Monitor | Dedupe key (cap) | Event ID | Outbox |
| --- | --- | --- | --- |
| BountyBoard | `processed_bounty_ids` (100) | bounty `id` | yes, `GG_BOUNTY_WEBHOOK` |
| Crates | `processed_crate_ids` (100) | crate `id` | yes, `GG_CRATES_WEBHOOK` |
| GameUpdates | `processed_update_archive_ids` (100) | news `id`; one part per 2000-char chunk | yes, `GG_NEWS_WEBHOOK` |
| GuildMessages | `processed_guild_message_ids` (100) | message `id` | yes, `GG_GUILD_MESSAGE_WEBHOOK` |
| Ladder | `processed_ladder_news_ids` (100) | news `id`; reset is part 0, band results parts 1..n | yes, `GG_LADDER_WEBHOOK` |
| Relics | `processed_relic_log_ids` (500) | guild log `id` | yes, `GG_RELIC_WEBHOOK` |
| Shoutbox | `processed_shoutbox_ids` (100) | shout `id` | yes, `GG_SHOUTBOX_WEBHOOK` |
| SuperElite | `processed_se_kill_ids` (200) | derived `minute-player-creature` | yes, `GG_SUPER_ELITE_WEBHOOK` |
| Titans | `processed_titan_news_ids` (100) | news `id` | yes, `GG_TITAN_WEBHOOK` |
| GuildConflicts | `active_guild_conflicts` / `gvg_cooldowns` state objects | conflict state key | no: a live counter that posts then edits by message ID |
| QoL | `current_gear_state` | none | no: sends no Discord alert |

Scoped follow-ups (not blocking): (1) SuperElite's event ID is derived, not a game ID; a kill whose server-relative time shifts across a minute boundary between polls can still be announced twice, as before. (2) Ladder band results are fetched after the reset claim; a crash between the claim and that fetch loses them. (3) GuildConflicts' live counter still uses direct `sendAndGetMessageId`/`editDiscordMessage` without durability.

### Decisions

- **Claim:** `claimNotification()` locks the account's processed list row (`<key>@<account scope>`), appends the ID with the monitor's existing FIFO cap, and inserts the outbox rows in one transaction. An ID found in that account's list or outbox is not claimed. An event whose alert cannot be built stays unclaimed and is retried on the next run (corrected by counter-plan O2; claiming it without a row contradicted AC-1). An event built with no alert, or only alerts for an unconfigured webhook, is claimed without a row (the module sent nothing before).
- **Account scope:** each row carries `env` or `profile:<id>`, and its identity is `(source, account_scope, event_id, part)` (migration 015, counter-plan O1). The legacy shared processed lists are no longer written; an account's own list starts as a copy of the legacy list, so legacy IDs count as processed for every account and age out under the FIFO cap. At boot the scope is cleared while the game login runs, and the outbox starts only after `login()` and `ensureLogin()` succeed (`bootLogin.mjs`, counter-plan O3). Only rows of the active account are dispatched; the queue rechecks the scope before each POST and releases items from another account unsent. During a switch, the old account's due rows are queued and drained first; the scope is then cleared (no claims, no sends) until the new login succeeds. Rows of an inactive account stay pending ("held") until it is active again.
- **Retries:** one round is a full in-memory attempt from the recovery spec. Retryable outcomes (timeout, network, 5xx, rate limits exhausted) back off 60 s doubling to 30 min, for at most 12 rounds (about 3.5 h), then become `failed`. A 4xx is `failed` at once; when Discord rejects a merged batch, each row is first retried as its own message. A webhook setting removed after the claim fails the row as `unconfigured`.
- **Owner action:** `GET /api/notifications` (counts and failed/held/retrying rows, account shown by profile label, no payload or URL) and audited `POST /api/notifications/:id/retry|discard` behind session and CSRF; shown on the dashboard Notifications tab. Discarding keeps the dedupe ID.
- **Retention:** delivered rows are pruned after 7 days; pending and failed rows are kept.

### Duplicate window (AC-3)

Exactly-once delivery to Discord is not promised. An alert can be sent twice only when Discord accepts it and the process stops before the `delivered` update commits; on restart that row is still pending and is replayed once. If the update fails while the process keeps running, the row is not re-sent: the acknowledgement is retried on the next lookup. Rows claimed before this change have no outbox row, and historical processed IDs are never replayed.

### Remaining release checks

Node 22.20 `npm test`, the MySQL 8.4 CI job (now including `tests/discord-integration/outbox.test.mjs`), the Docker build and `docker compose config`, deploying migrations 014 and 015 together with the image, and checking for held or failed rows on the dashboard after the first production run.
