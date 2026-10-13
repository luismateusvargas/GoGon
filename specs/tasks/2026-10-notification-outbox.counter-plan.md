# Preserve claimed game alerts until Discord accepts them — counter-plan

Original task spec: specs/tasks/2026-10-notification-outbox.md
Review evidence: 2026-10-13 independent review of 8244aac..42cb44f and fake-MySQL reproductions
Status: implemented (pending review)

## Confirmed failures

- **O1, AC-4 account isolation:** `gg_database.js:250-254` checks one shared processed-ID list; `notificationOutbox.js:30-32` and migration `014_notification_outbox.sql:27` also identify a row by `(source, event_id, part)` without account scope. Reproduction with the migrated fake MySQL: claim `crates/4242` for `profile:a` returns true; claim the same game ID for `profile:b` returns false; only A has a pending row. B's alert is lost even though B is a separate game account. Existing tests use different IDs for each profile.
- **O2, AC-1 atomic alert handoff:** `app_modules/notify.js:27-40` catches an alert-build exception and still claims the event with an empty notification list. Reproduction: `build()` throws for event 77; `claimAlerts()` reports one claimed event, the processed list contains 77, and the outbox has zero rows. A transient database enrichment failure can therefore permanently suppress an alert. This is also described as an accepted implementation choice in the original spec's notes, but it conflicts with AC-1's requirement for a pending alert before the event is handled.
- **O3, AC-4 validated account boundary:** `control-plane/index.mjs:75-76` sets the account scope from the stored profile, then `app.mjs:108-114` starts and pumps the outbox before `app.mjs:126-138` validates the game login. Pending notifications can be posted for a profile whose login then fails. The switch path correctly clears scope until authentication succeeds; boot does not.

## Surgical corrections

- O1: Include account scope in the new outbox uniqueness and lookup, and use account-scoped dedupe history for new claims. Keep the legacy processed list readable and avoid bulk replay of old IDs; define a deterministic treatment for ambiguous pre-migration history so the migration remains additive and repeatable.
- O2: On an alert-build failure, leave that event unclaimed so the next monitor run can retry it. Keep the existing behavior for a successfully built event that intentionally yields no alert, including an unconfigured webhook. Test a real monitor's transient enrichment failure, not only the helper.
- O3: Start or wake the outbox only after `login()` and `ensureLogin()` succeed. Keep profile identity selection before login, but do not make it dispatch-eligible until validation completes. A failed boot must not send pending alerts.

## Acceptance and verification

| Finding | Targeted check and expected result |
| --- | --- |
| O1 | Fake and MySQL 8.4 tests claim the same source/event ID under two profiles; each gets one correctly scoped pending row, and switching sends only the active profile's row. Existing legacy history remains readable. |
| O2 | A monitor build that fails once leaves no processed ID; the next run builds and atomically claims one pending notification. |
| O3 | Boot test with a stored profile and failed login records zero webhook posts; successful login replays pending rows once. |

Completion means O1–O3 are fixed, focused monitor/outbox/account-switch tests pass on fake and real MySQL, and the migration is safe to re-run.

## Blockers

The ownership of IDs in the old shared processed lists is not recoverable for installations that switched profiles before this migration. The correction must document and test its deterministic compatibility rule; it must not assign old rows to a guessed profile or bulk replay them.

## Corrections (2026-10-13)

- O1: Migration `015_outbox_account_identity.mjs` adds the unique key `notification_outbox_account_event (source, account_scope, event_id, part)` and then drops `notification_outbox_event`. Each step tolerates having run before. `insertOutboxRows()` checks for existing rows per account. Dedupe history moves to per-account lists (`gg_database.processedListKey`: `<key>@<scope>`). Monitors read them through `notify.js processedContent()`.
- **Compatibility rule** (blocker resolved): nothing writes to the legacy shared list anymore, and it stays readable. On an account's first claim, its own list is created as a copy of the legacy list, capped at the monitor's limit. Until then the monitor reads the legacy list. Every account therefore treats a legacy ID as already processed. No ID is assigned to a guessed account and none is bulk replayed. The copied IDs age out under the existing FIFO cap. Cost: an account that never saw a legacy ID cannot claim that same ID until it ages out of that account's list.
- O2: `claimAlerts()` leaves an event unclaimed when its build rejects, and still claims later events. A successful build with no configured alert is still claimed without a row.
- O3: `bootLogin.mjs loginBeforeDelivery()` clears the account scope while `login()`/`ensureLogin()` run. It restores the scope and starts the outbox only after both succeed. `app.mjs` no longer starts the outbox before login.
- Tests: `tests/discord-integration/outbox.test.mjs` (same ID under two profiles, scoped rows and dispatch, legacy seeding and age-out, 015 re-run, and the boot login/ensureLogin failure and success cases), `tests/game-monitors/monitors.test.mjs` (helper retry, and a SuperElite build that fails once while the creatures table is unreadable, then is claimed once), and `tests/auth-session/login-recovery.test.mjs` (app.mjs does not start the outbox before login).
- Not verified locally: the MySQL 8.4 run, which needs `ER_DUP_KEYNAME`/`ER_CANT_DROP_FIELD_OR_KEY` handling in 015 and the `RENAME TABLE` test on InnoDB.
