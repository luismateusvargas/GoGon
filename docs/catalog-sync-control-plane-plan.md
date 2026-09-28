# Fallen Sword Catalog Sync: delivery plan

Status: locked by `catalog-sync-v1` 1.1.0 (2026-09-28). Stage 1 (CAT-TASK-002, durable catalog store) is implemented; no collector or control-plane work has started, and live collection still waits on CAT-TASK-001.

## Outcome

Integrate a passive Fallen Sword catalog collector into GoGon's existing authenticated session and expose it through a new owner-only `Catalog` tab in the existing loopback-only control plane. It catalogs items, creatures, realms, master realms, relics, and quests while preserving source provenance and avoiding gameplay actions.

The Catalog tab contains four subviews:

1. **Browse**: paginated catalog records, relations, source, first/last observed, and freshness.
2. **Sync**: bounded, resumable observation and item-frontier jobs.
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

## Work sequence

| Stage | Tasks | Prerequisites | Exit evidence |
| --- | --- | --- | --- |
| 0. Contract gate | CAT-TASK-001 | Owner-authorized read-only live observation | Captured field contract, response classifications, and written request-rate/policy decision. |
| 1. Durable catalog store | CAT-TASK-002 | None | Migration passes against fake and real MySQL; transaction and rollback tests pass. |
| 2. Passive collector | CAT-TASK-003 | Stages 0-1 | Fixture tests prove current-realm/creature collection, one request in flight, aborted run, no cursor loss, and no action endpoint. |
| 3. Scheduler integration | CAT-TASK-004 | Stage 2 | Disabled-by-default task is visible; account-switch pause/resume and conflict tests pass. |
| 4. Owner API | CAT-TASK-005 | Stages 1 and 3 | Auth, CSRF, same-origin, pagination, audit, SSE, conflict, plan-expiry, and denial tests pass. |
| 5. Catalog tab | CAT-TASK-006 | Stage 4 | Browser acceptance proves browse and job feedback; text is safely rendered; destructive execution needs exact confirmation. |
| 6. Safe baseline seed | CAT-TASK-007 | Stages 1 and 4 | Invalid inputs make no writes; preview/projection/rollback tests pass; legacy full-replace script remains untouched. |
| 7. Release gate | CAT-TASK-008 | Stages 5-6 | CI, real MySQL, Docker loopback, SSH-tunnel browser, and controlled passive live-observation evidence are all captured. |

## Data boundaries

New catalog tables hold runs, durable job cursors, normalized observations, relation/projection provenance, and deletion plans. Existing `items`, `creatures`, `realms`, `master_realms`, and `relics` remain the serving projection so Discord integrations do not change their lookup contract during rollout.

An observation contains game-domain data only. It must never contain account pages, cookies, credentials, CSRF values, raw debug snapshots, or arbitrary HTML. A source record distinguishes `game_session`, `guide_baseline`, and `manual_import`.

## Acceptance invariants

- A failed, throttled, mitigated, malformed, or unauthenticated response never advances a collector cursor.
- A catalog response cannot produce combat or navigation side effects.
- Only code-owned operation and source allowlists can start work; no dashboard value becomes a URL, shell command, database identifier, or SQL fragment.
- The minimum initial delay is three seconds and the maximum default job budget is 50 requests; these remain conservative until an owner-approved policy/rate decision replaces them.
- A delete/rollback plan expires within ten minutes, may be used once, is revision-checked, and states its exact affected counts before it can mutate data.
- A rollback restores the newest remaining provenanced record or removes the entity and its relations atomically when no predecessor exists.

## Deferred inputs

These do not block schema, fixture, UI, or security work, but they block production collection or promotion where indicated.

| Input | Owner decision needed by | Why |
| --- | --- | --- |
| Fallen Sword acceptable request budget and collection policy | Before CAT-TASK-003 live test | Avoid account-impacting collection behavior. |
| Exact live response field contract for realm and creature detail reads | CAT-TASK-001 | FSH source is strong precedent, but a live response must lock the implementation schema. |
| Approved seed baseline artifacts/source keys | Before CAT-TASK-007 promotion | A public guide baseline is stale and Cloudflare-protected; no arbitrary URL importer is allowed. |
| Long-term catalog observation retention and MySQL backup policy | Before production deployment | Determines storage growth and recovery guarantees. |

## Non-goals for v1

- No game movement, attacks, combat automation, or Cloudflare/CAPTCHA bypass.
- No promise that unvisited content, unobserved drops, or unknown set bonuses are complete.
- No publicly exposed control plane, MySQL port, generic DB browser, or raw SQL console.
- No replacement of Discord serving tables or manual legacy `populate_db` workflow until its staged successor has passed the release gate.
