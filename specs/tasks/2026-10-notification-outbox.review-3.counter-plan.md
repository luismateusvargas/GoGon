# Keep incomplete Ladder results recoverable — review counter-plan

Original task spec: specs/tasks/2026-10-notification-outbox.md
Reviewed correction: specs/tasks/2026-10-notification-outbox.review-2.counter-plan.md
Review evidence: 2026-10-13 independent review of 97e5d59..fd6b61d
Status: ready

## Confirmed failures

- **O6, O5 acceptance / outbox AC-2:** `app_modules/Ladder.js:159-164` deletes an unfinished reset's durable follow-up record after five failed fetch runs. The reset remains in the processed-ID list, so a later run cannot discover the missing parts after the game endpoint recovers. `tests/game-monitors/ladder-followups.test.mjs:133-147` explicitly asserts this permanent loss: after the fifth failure, a successful band response still produces no part 3. The owner has no inspectable failed follow-up record or retry action.
- **O7, O5 acceptance:** `app_modules/Ladder.js:82-96,107-137` counts a fulfilled HTTP/JSON read as a successful band fetch without requiring the game response's `s` flag or usable `previous` data. It then skips that band in the append loop but returns complete because `allResults.length === bands.length`, deleting the follow-up record. Controlled fake-MySQL reproduction: a reset 5050 with one band whose response is `{s:false}` leaves only outbox part 0 and `ladder_followups@profile:a` absent. A later valid response cannot restore the band alert.
- **O8, contract accuracy:** `specs/game-monitors.spec.yaml:19` still states that a crash between the reset claim and band fetch loses the results, although O5 persists a follow-up record before the claim and retries it on later runs. The domain definition gives the owner and future implementers the wrong recovery contract.

## Surgical corrections

- O6: Keep an unfinished claimed reset durable after a bounded number of fetch failures. Bound request frequency with backoff, or retain an inspectable failed state that the owner can retry. Do not erase the only recovery identity while band parts remain missing.
- O7: Treat a rejected or unusable band response as incomplete. Remove the follow-up record only after every band has a valid result (including a valid empty result) and every applicable part has been enqueued or already exists. Preserve stable part numbers and account binding.
- O8: Update the game-monitor domain definition and changelog/version to describe the actual recovery and terminal-state behavior after O6–O7 are fixed.

## Acceptance and verification

| Finding | Targeted check and expected result |
| --- | --- |
| O6 | Fail one band's fetch for more than five runs, then recover: the original account retains a recoverable or owner-retryable follow-up and eventually gets the missing part exactly once; other accounts receive none. |
| O7 | Return HTTP 200 with `{s:false}` for one band, then a valid response on a later run: the marker remains after the rejection, the missing part is added once after recovery, and valid empty bands can complete without an alert. |
| O8 | The versioned domain definition matches the tested behavior for crash, account switch, and exhausted retries. |

Completion means all three corrections and the existing Ladder, monitor, outbox, and account-switch suites pass on fake MySQL and MySQL 8.4.

## Blockers

None.
