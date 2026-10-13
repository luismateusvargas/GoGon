# Restore forward progress in Discord webhook delivery

Status: implemented (pending review)
Project: specs/project.yaml
Constitution: specs/constitution.yaml
Related domains: specs/discord-integration.spec.yaml, specs/task-engine.spec.yaml

## Outcome and non-goals

An outbound Discord request that hangs or repeatedly fails cannot stop all later alerts indefinitely. This spec changes delivery behavior; persistence of events and operator health signals are separate dependent specs.

## Current contracts and impact

- `utils.js` batches notifications for 100 ms, posts through one `messageQueue`, and enforces 2000 ms between successful posts. `securePostDiscord()` uses `node-fetch` with no explicit request deadline. `processQueue()` awaits the first entry and handles 429 by sleeping and retrying the same head indefinitely. A pending request therefore leaves `processingQueue` true and blocks every webhook without a rejection or error log.
- `sendAndGetMessageId()` and `editDiscordMessage()` use the same post helper for immediate GvG messages; preserve their return contracts.
- Monitors call `sendDiscordMessage()`/`sendExtraDiscordMessage()` without awaiting delivery. Existing tests in `tests/discord-integration/delivery.test.mjs` cover batching and 429 but no hanging request.
- Production trigger is unconfirmed: there is no VPS queue snapshot, request trace, or timestamped delivery metric in this checkout. The reported last Discord arrival is 05/10/2026 23:47; confirm date format and timezone against VPS logs before tying it to a deploy or request.

## Acceptance criteria

- AC-1: Given one webhook POST never settles, its configured finite deadline expires, the attempt is recorded as a sanitized timeout, and a later notification to another webhook is attempted. The queue does not remain permanently busy.
- AC-2: Given HTTP 429 with a valid `retry_after`, the item is retried no earlier than that delay while other eligible destinations can progress and the global two-second send spacing remains intact. A malformed retry value cannot create an endless tight loop or infinite sleep.
- AC-3: Given a transient network error or 5xx, retries are bounded and the failed item reaches an explicit failure outcome; a 4xx other than 429 is classified as permanent. The queue continues processing later items and never logs a webhook URL or payload.
- AC-4: Given no pending work and a completed send, queue state is reset so a later enqueued item starts processing. Existing batching, embed limits, immediate message ID, and edit return behavior remain intact.

## Design and ordered work

1. Add an abortable deadline to every `node-fetch` request in `securePostDiscord()` in `utils.js`, including response-body reads. Use one bounded retry policy and normalize status, timeout, and rate-limit categories. Keep the deadline and retry constants named in one place and test their values with a controlled clock.
2. Rework `processQueue()` so each item has an eligibility time and attempt state. After a rate limit, allow other eligible destinations to send while respecting the existing global 2000 ms spacing. Use `try/finally` for `processingQueue`, and ensure a newly queued item wakes a sleeping dispatcher. Do not expose raw URLs in errors.
3. Extend `tests/discord-integration/delivery.test.mjs` with a never-resolving mocked fetch, 429 and malformed-delay sequences, 5xx exhaustion, a permanent 4xx, and late enqueue after idle. Assert order, spacing, sanitized diagnostics, and eventual progress. Keep test fixtures offline.

## Verification

| Criterion | Check and expected result |
| --- | --- |
| AC-1 | Run `npm test`; a mocked pending POST times out and the next webhook is attempted. |
| AC-2 | Mock 429 and fake time; eligible work proceeds and every POST respects the two-second global gap. |
| AC-3 | Mock timeout, 5xx, malformed 429, and 4xx; each has a bounded outcome and no secret output. |
| AC-4 | Run existing delivery, GvG, and full test suites; batching and direct-message contracts pass. |

## Change safety

No schema migration. Preserve webhook settings and public control-plane API. Roll out with the next container image; compare queue progress and errors before and after. Reverting the image restores old delivery behavior but also restores the stall risk. Failed in-memory items remain lossy until the durable outbox spec is implemented.

## Open decisions and sources

None blocks implementation. VPS evidence is needed to confirm the exact incident trigger. Sources: `utils.js`, `tests/discord-integration/delivery.test.mjs`, `specs/discord-integration.spec.yaml`, `compose.yaml`.
