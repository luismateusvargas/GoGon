# Keep monitor alerts with the account that produced them — review counter-plan

Original task spec: specs/tasks/2026-10-notification-outbox.md
Reviewed correction: specs/tasks/2026-10-notification-outbox.counter-plan.md
Review evidence: 2026-10-13 independent review of ebcecfd..3c4a85b
Status: ready

## Confirmed failures

- **O4, AC-4 account isolation:** `app_modules/notify.js:33-45` builds alerts asynchronously, then reads the *current* account scope at claim time. `app_modules/notify.js:61-64` does the same for follow-up parts. `engine.js:261-269,312-320` stops waiting for an in-flight monitor after 30 seconds, and `control-plane/accountSwitch.mjs:52-82` can then activate another profile while that monitor finishes. A monitor result fetched under profile A can therefore be claimed and dispatched as profile B. Reproduction with the fake MySQL: start `claimAlerts()` under `profile:a`, hold its `build()`, change scope through null to `profile:b`, then release `build()`; the stored row is `account_scope=profile:b` with payload `from A: 4242`.

## Surgical corrections

- O4: Bind each monitor run to the account scope that was active before its first account-specific read. Pass that scope through processed-history reads, claims, and follow-up parts. If the active scope changes before a claim or append, leave that old result unclaimed so a later run under the correct account can handle it. Keep the 30-second account-switch wait bounded and preserve per-account dedupe, pending rows, and the validated-login dispatch gate.

## Acceptance and verification

| Finding | Targeted check and expected result |
| --- | --- |
| O4 | Fake-MySQL monitor test holds an A fetch or alert build through a switch to B, then resumes it: no A payload or event ID enters B's processed list or outbox. A later A run can claim it; a fresh B run may independently claim B's event with the same ID. Repeat for `appendAlerts()` follow-up parts. |

Completion means O4 is fixed, the targeted race test and existing monitor, outbox, and account-switch suites pass, and MySQL 8.4 confirms account-scoped persistence.

## Blockers

None.
