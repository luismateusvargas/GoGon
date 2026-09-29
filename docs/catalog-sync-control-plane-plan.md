# Fallen Sword Catalog Sync: delivery plan

Status: implemented on `feat/CAT-TASK-009-guide-discovery-stack` against `catalog-sync-v1` 1.3.1 (2026-09-28). CAT-TASK-002..007, 009, and 010 are done. CAT-TASK-001 waits on one owner-captured `fetchLocation` response (DEC-CAT-019); guide index order rests on the owner attestation (DEC-CAT-017) until the first live relay sweep records it as verified. The CAT-TASK-008 release gate has its automated part done; its live evidence (real-MySQL CI run, Docker loopback, SSH-tunnel browser acceptance, a live relay sweep, a live passive observation) is open.

## Outcome

Integrate a passive Fallen Sword catalog collector into GoGon's existing authenticated session and expose it through a new owner-only `Catalog` tab in the existing loopback-only control plane. It catalogs items, creatures, realms, master realms, relics, and quests while preserving source provenance and avoiding gameplay actions.

The Catalog tab contains four subviews:

1. **Browse**: paginated catalog records, relations, source, first/last observed, and freshness.
2. **Sync**: bounded current-location observation, conditional game-side frontiers, and daily guide discovery with due/challenged/waiting-for-browser status.
3. **Seed**: staged, validated baseline imports and promotion previews.
4. **History & delete**: run history plus preview-confirm rollback/deletion plans.

## Locked decisions

| ID | Decision |
| --- | --- |
| DEC-CAT-001 | Reuse GoGon's `session.mjs` authenticated cookie jar and fetch path; do not add Playwright, a second login, or cookie export. |
| DEC-CAT-002 | The collector is passive, disabled by default, one request at a time, and never calls attack, move, travel, equip, use-item, post-form, or account-management endpoints. |
| DEC-CAT-003 | Catalog management belongs in the existing authenticated control plane and stays host-loopback-only. Remote access uses an owner SSH tunnel. |
| DEC-CAT-004 | Observations and runs are retained before projecting incremental updates into the existing Discord-serving tables. Guide data is a dated baseline rather than current truth. |
| DEC-CAT-005 | `scripts/populate_db.mjs` remains manual-only because it clears master tables. Catalog seed/import uses staged validation and promotion instead. |
| DEC-CAT-006 | Remote destructive work is plan-preview-confirm and transactional. There is no raw SQL, arbitrary URL fetch, raw table console, or arbitrary file-path interface. |
| DEC-CAT-007 | Cloudflare/CAPTCHA controls are never automated or bypassed. Mitigation pauses collection and preserves the cursor. |
| DEC-CAT-008 | (2026-09-28) The first catalog write to an existing serving row stores that row as a `guide_baseline` observation, so rollback restores legacy data. Untouched rows are never copied. |
| DEC-CAT-009 | (2026-09-28) `scripts/populate_db.mjs` refuses to run while catalog projections exist unless given `--discard-catalog-projections`; that flag marks catalog runs discarded (no longer rollback-able). |
| DEC-CAT-010 | (2026-09-28) Serving relations are normalized with foreign keys: `quests`, `realm_creatures`, `creature_drops`, plus retrofitted keys on `realms.master_realm_id` and `relics.realm_id`. Writers upsert and never `REPLACE INTO`. |
| DEC-CAT-011 | (2026-09-28) Provenance and projection commit in separate transactions; a failed projection leaves a failed run with only a redacted error code. |
| DEC-CAT-012 | (2026-09-28) The supplied `reconciliation/scrappers` userscripts are the source for guide URLs and parser fields. Item, creature, realm, and master-realm indexes are checked every 24 hours through a validated owner browser relay; the guide is an ongoing discovery source as well as a baseline. |
| DEC-CAT-013 | (2026-09-28) Each guide kind retains a last seen ID and last successful scan. A page-overlap optimization requires verified ID ordering; until then every index page is checked. Due older details are refreshed because an ID watermark cannot detect edits or changed drop lists. |
| DEC-CAT-014 | (2026-09-28) Item and creature catalog entities expose `complete` or `incomplete`, missing-data reasons, and verification time. Complete means required guide fields and all currently known drop links have been checked; it cannot prove that no unobserved drop exists. |
| DEC-CAT-015 | (2026-09-28) The guide userscript gains `GM_xmlhttpRequest`, `GM_getValue`, `GM_setValue`, and `@connect 127.0.0.1`. A seven-day maximum, revocable, stage-only token issued from the authenticated Catalog tab authorizes bounded normalized batches to a dedicated loopback endpoint through the owner's SSH tunnel. This endpoint alone accepts a token instead of dashboard session, same-origin, and CSRF; all normal Catalog mutations retain those checks. The server may auto-project validated batches only under a previously owner-enabled guide job. Review the exception after browser acceptance. |
| DEC-CAT-016 | (2026-09-28) Guide index order is unverified. Until CAT-TASK-001 verifies ID sorting, each complete daily check covers every index page, checkpointed in approved chunks. `last_seen_id` never skips a page. The guide gets its own minimum delay, per-run budget, daily cap, and duration estimate before scheduled collection. |
| DEC-CAT-017 | (2026-09-28, supersedes the "unverified" part of DEC-CAT-016) The owner attests that guide index pages start at `index=0`, which holds the newest records; the last page holds the oldest (`catalog/contracts/guide.js` `GUIDE_ORDERING`). A daily check may stop one overlap page past the page that reaches `last_seen_id`, but every run re-checks that IDs descend within and across pages. A violation returns that kind to full sweeps. A full sweep still runs every 7 days to catch gaps and edits. |
| DEC-CAT-018 | (2026-09-28) Guide policy (`catalog/contracts/policy.js` `GUIDE_POLICY`): one request in flight, 3 s minimum delay, 50 requests per relay lease, 2,000 requests per UTC day, 24 h check interval, one overlap page, 7-day full sweep, 30-day detail refresh (10 per lease), 5 detail attempts, and a 60-minute wait before retrying a sweep stopped by a bad or failed page. The estimated full sweep is 1,279 index pages (661 item, 321 creature, 282 realm, 15 master realm): 26 leases and at least 64 minutes, inside the cap with 721 requests left for details. A first full detail pass over ~30,000 records takes about 15 days at this cap, so seed a baseline first (CAT-TASK-007). |
| DEC-CAT-019 | (2026-09-28) The game `fetchLocation` response has never been captured. `catalog/contracts/gameLocation.js` stays unverified with no field mapping, and observe_realm jobs are refused until an owner captures one redacted response, commits it as a fixture, and fills in the mapping. No game creature- or item-detail read exists, so item_frontier is unavailable. |
| DEC-CAT-020 | (2026-09-28) The approved seed source key is `fsdatabase`: the same four snapshot files `scripts/populate_db.mjs` loads. Seeding stages them as ordered parts of at most 2,000 observations; each part is promoted through a previewed plan with an exact confirmation, in order. `populate_db.mjs` stays manual and unchanged. |
| DEC-CAT-021 | (2026-09-28) Rolling back a `guide_discovery` run returns the guide details it staged to unverified (pending, no hash), so completeness no longer claims them. Their next read keeps the normal detail refresh interval (30 days) instead of running at once, so the rollback holds until then. A relay lease is checkpointed only with the exact results its staged run was built from, and only while that run is applied; otherwise the lease is closed without moving checkpoints and its pages are read again. |
| DEC-CAT-022 | (2026-09-29, supersedes DEC-CAT-017 and the daily cap in DEC-CAT-018) Low-level releases can add item, creature, and realm IDs on any index page. Every due check covers all pages for each active guide kind, ending at the repeated final page. Index IDs already tracked do not trigger immediate detail reads; new IDs and separately due refreshes do. The 2,000-request daily cap is removed, while requests remain serial, three seconds apart, with at most 50 in a lease and visible daily usage. Standalone quest and relic discovery is deferred by the owner. |

## Work sequence

| Stage | Tasks | Prerequisites | Exit evidence |
| --- | --- | --- | --- |
| 0. Contract map | CAT-TASK-001 | Existing API.js and supplied guide scrapers | Source-backed contracts and fixtures; verified guide page order or full-sweep plan; separate guide delay, per-run budget, daily cap, page count, and duration. Optional game detail reads require their own validated contract before use. |
| 1. Durable catalog store | CAT-TASK-002 | None | Migration passes against fake and real MySQL; transaction and rollback tests pass. |
| 2. Passive collector | CAT-TASK-003 | Stages 0-1 | Fixture tests prove current-realm/creature collection, one request in flight, aborted run, no cursor loss, and no action endpoint. |
| 3. Scheduler integration | CAT-TASK-004 | Stage 2 | Disabled-by-default task is visible; account-switch pause/resume and conflict tests pass. |
| 4. Owner API | CAT-TASK-005 | Stages 1 and 3 | Auth, CSRF, same-origin, pagination, audit, SSE, conflict, plan-expiry, and denial tests pass. |
| 5. Discovery metadata | CAT-TASK-009 | Stage 1 | Forward migration on upgraded MySQL stores guide checkpoints and item/creature completeness; projection and rollback tests pass. |
| 6. Catalog tab | CAT-TASK-006 | Stages 4-5 | Browser acceptance proves browse, completeness, and job feedback; text is safely rendered; destructive execution needs exact confirmation. |
| 7. Safe baseline seed | CAT-TASK-007 | Stages 1 and 4 | Invalid inputs make no writes; preview/projection/rollback tests pass; legacy full-replace script remains manual. |
| 8. Guide relay | CAT-TASK-010 | Stages 0, 5-7 | Browser relay reaches the staging-only loopback endpoint with a scoped token; cross-route and expired-token tests deny access. Daily full sweeps while order is unverified find new IDs, older changes trigger refresh, and a challenge or budget limit pauses without false success. |
| 9. Release gate | CAT-TASK-008 | Stages 6-8 | CI, real MySQL, Docker loopback, SSH-tunnel browser, daily-guide lifecycle, and controlled passive live-observation evidence are captured. |

## Data boundaries

New catalog tables hold runs, durable job cursors, normalized observations, relation/projection provenance, and deletion plans. Existing `items`, `creatures`, `realms`, `master_realms`, and `relics` remain the serving projection so Discord integrations do not change their lookup contract during rollout.

CAT-TASK-009 adds durable guide discovery checkpoints by kind and complete/incomplete metadata for item and creature catalog entities. The guide's highest seen ID is a scan hint, not an exclusion rule. Until guide ID order is confirmed, every index page is checked for a complete daily scan; checkpoints let a sweep resume across bounded executions. A verified ID order may later allow an overlap optimization, while due older details still need refresh. New game-session creature identity from `fetchLocation` can be stored immediately; its drops stay incomplete until verified.

The guide script reads guide pages in the owner's validated browser. Its extension-isolated `GM_xmlhttpRequest` sends only normalized batches to `127.0.0.1` through the owner SSH tunnel. The owner issues and can revoke its stage-only token from the authenticated Catalog tab; the token expires within seven days and remains in extension storage, outside guide page JavaScript. The dedicated relay endpoint is the single exception to dashboard session/CSRF/same-origin mutation checks. It cannot accept raw HTML, arbitrary URLs, promotion, deletion, or job commands. A previously owner-enabled guide job validates staged observations and may project them automatically under its fixed source and request policy. Owner seed uploads and destructive actions still use their existing plan-preview-confirm path.

An observation contains game-domain data only. It must never contain account pages, cookies, credentials, CSRF values, raw debug snapshots, or arbitrary HTML. A source record distinguishes `game_session`, `guide_baseline`, and `manual_import`.

## Acceptance invariants

- A failed, throttled, mitigated, malformed, or unauthenticated response never advances a collector cursor.
- A guide challenge pauses the browser relay and waits for normal owner validation; no challenge token, cookie, or raw page enters the Catalog API or database. If no validated browser is available, the daily check remains due and visible rather than reporting success.
- The existing userscripts' fixed page ceilings and high concurrency are not the scheduled policy. The relay serializes requests, validates index and detail pages, persists checkpoints only after success, and applies a separate guide delay and per-run budget.
- The daily guide check is complete when the guide repeats the previous nonempty page's IDs. The last valid page's IDs persist across leases so the repeated-page check works at a lease boundary. An empty, stopped, or challenged sweep is partial/overdue, preserves its page cursor, and does not update last successful check or claim that no IDs were added.
- The relay token is stage-only, revocable, and expires within seven days. The relay endpoint denies missing/expired/wrong-scope tokens and cannot reach ordinary Catalog mutations; normal owner APIs retain session, same-origin, and CSRF checks.
- A catalog response cannot produce combat or navigation side effects.
- Only code-owned operation and source allowlists can start work; no dashboard value becomes a URL, shell command, database identifier, or SQL fragment.
- Game requests keep their three-second minimum delay and default 50-request execution budget. CAT-TASK-001 defines the separate guide policy before a scheduled guide run; the guide cannot inherit the game budget by accident.
- A delete/rollback plan expires within ten minutes, may be used once, is revision-checked, and states its exact affected counts before it can mutate data.
- A rollback restores the newest remaining provenanced record or removes the entity and its relations atomically when no predecessor exists.

## Deferred inputs

These do not block schema, fixture, UI, or security work, but they block production collection or promotion where indicated.

| Input | Owner decision needed by | Why |
| --- | --- | --- |
| One captured, redacted `fetchLocation` response and its field mapping | Before any observe_realm job (DEC-CAT-019) | The response body has never been seen. The collector, classification, and normalizer are built and tested against a synthetic contract; the production contract stays unverified until this capture. |
| Confirmation of the guide policy numbers (DEC-CAT-018) | Before the first daily guide job is enabled | The numbers are conservative defaults. Enabling the guide job in the Catalog tab shows them; changing them is a code change. |
| Separate game creature/item detail response contract | Before enabling those game-side frontiers | `API.js` defines current-location and world-map reads but no separate creature/item detail builder. This does not block guide discovery or location identity collection. |
| Validated owner browser availability for guide checks | Before unattended daily operation | A due check can wait for browser validation after a Cloudflare challenge; headless server fetch has not been established as reliable. |
| Confirmation that `fsdatabase` (DEC-CAT-020) is the baseline to promote | Before the first seed promotion | It is the snapshot the legacy script already loads; staging it writes nothing to serving tables, promotion is per part and confirmed. |
| Long-term catalog observation retention and MySQL backup policy | Before production deployment | Determines storage growth and recovery guarantees. |

## Non-goals for v1

- No game movement, attacks, combat automation, or Cloudflare/CAPTCHA bypass.
- No claim that unobserved drops or unknown set bonuses are complete; the complete/incomplete field describes checked source coverage and currently known relations.
- No publicly exposed control plane, MySQL port, generic DB browser, or raw SQL console.
- No replacement of Discord serving tables or manual legacy `populate_db` workflow until its staged successor has passed the release gate.
