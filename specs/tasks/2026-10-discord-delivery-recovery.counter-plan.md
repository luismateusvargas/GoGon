# Restore forward progress in Discord webhook delivery — counter-plan

Original task spec: specs/tasks/2026-10-discord-delivery-recovery.md
Review evidence: 2026-10-13 independent review of f007f55..42cb44f
Status: implemented (pending review)

## Confirmed failures

- **R1, AC-2 / eventual retry:** `utils.js` `nextEligibleItem()` (around line 280) chooses the lowest `notBefore`, while new items use `notBefore: 0` (around line 158). A rate-limited item receives a future `notBefore`. Once it is eligible, a sustained stream of fresh messages for other webhooks still has `notBefore: 0` and wins every dispatch. The old alert can starve indefinitely even while Discord has recovered. The existing 429 test drains a finite queue, so it does not cover this trigger. Reproduction with mocked `node-fetch` and a fake clock: A receives 429 at t=0 with a 5.5-second pause; ten B messages are queued; through t=12 seconds the POST sequence is A, B, B, B, B, B, B, with no A retry although it became eligible at t=5.5 seconds.

## Surgical corrections

- R1: Pick the oldest *eligible waiting item* across webhook heads, using its original queue order or `queuedAt` for fairness. Keep `notBefore` only as the eligibility gate and preserve per-webhook ordering and the global two-second POST gap.

## Acceptance and verification

| Finding | Targeted check and expected result |
| --- | --- |
| R1 | Fake-clock queue test sustains fresh B traffic after A's 429 delay; A is retried within a bounded number of dispatches, never before `retry_after`, and all POST starts remain at least two seconds apart. |

Completion means R1 is fixed, the targeted test and existing delivery suite pass, and no URL or payload appears in diagnostics.

## Blockers

None.

## Corrections (2026-10-13)

- R1: `nextEligibleItem()` returns the first eligible webhook head in queue order. Items keep their queue position across retries, so `notBefore` is only the eligibility gate. Per-webhook order and the global two-second gap are unchanged.
- Test: `tests/discord-integration/delivery.test.mjs` "sustained fresh traffic for another webhook cannot starve an eligible rate-limit retry" (fails before the fix with A, B0..B5 and no retry). With the fix, A is retried as the third POST, at least 5.5 s after the 429, and every gap is at least 2 s. The 5xx test now expects A, A, A, B: A's retry is due exactly when the gap ends, and A was queued first. It stays bounded at 3 attempts, then B is sent.
