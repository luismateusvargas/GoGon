# Recover Ladder follow-up alerts interrupted by an account switch — review counter-plan

Original task spec: specs/tasks/2026-10-notification-outbox.md
Reviewed correction: specs/tasks/2026-10-notification-outbox.review.counter-plan.md
Review evidence: 2026-10-13 independent review of 816cb38..28c42d2
Status: ready

## Confirmed failures

- **O5, O4 acceptance / outbox AC-4:** `app_modules/Ladder.js:152-173` claims and dedupes a reset before fetching its band results. If an account switch happens during that fetch, `app_modules/notify.js:77-84` drops the follow-up parts. On a later run under the original account, `app_modules/Ladder.js:139-145` filters out the already processed reset, so those parts are never fetched or appended again. Controlled fake-MySQL reproduction: claim reset 4242 under profile A, hold the band fetch, switch to B, release it, switch back to A, and rerun the monitor. The outbox contains only part 0 under A and the A dedupe list contains 4242; part 1 remains absent. The new O4 test manually calls `appendAlerts()` with a fresh binding, but the monitor has no path that makes that call for a processed reset.

## Surgical corrections

- O5: Make incomplete Ladder follow-up work recoverable under the account that claimed the reset. Retain enough durable reset identity and completion state for a later run under that account to revisit it and append missing parts idempotently; a run under another account must not store or send those results. Preserve the reset's existing dedupe identity, per-account outbox uniqueness, and alert format. Avoid refetching completed resets indefinitely.

## Acceptance and verification

| Finding | Targeted check and expected result |
| --- | --- |
| O5 | Hold a Ladder band fetch after profile A's reset claim; switch to B, release, switch back to A, and rerun `checkLadderReset()`. No A payload enters B's list or outbox. A's later run appends each missing band part once, and another run adds no duplicate part. Run the existing monitor, outbox, and account-switch suites. |

Completion means this interrupted follow-up path recovers without cross-account delivery on fake MySQL and MySQL 8.4.

## Blockers

None.
