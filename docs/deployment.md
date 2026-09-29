# GoGon deployment (Docker Compose)

This guide covers the private container deployment defined by `control-plane-v1` (CTRL-TASK-006,
AC-CTRL-005) and `data-storage-v1` 2.0.0 (DATA-TASK-008). GoGon runs as a non-root user on Node 22
with a read-only root filesystem. Its database is the bundled `mysql` service (MySQL 8.4), which
publishes no port and keeps its data in the named volume `gogon-mysql`. The owner dashboard is
published on `127.0.0.1` only.

## 1. Prepare `.env`

Copy `.env.example` to `.env` and fill in the game, Discord, and webhook values. Then add the four
control-plane bootstrap values. Never commit `.env` or paste it into tickets or chats.

```sh
node scripts/control-plane/generate-secrets.mjs      # prints GG_CONTROL_SESSION_SECRET and GG_CONTROL_ENCRYPTION_KEY
node scripts/control-plane/hash-password.mjs         # prompts for the dashboard password; prints GG_ADMIN_PASSWORD_HASH
```

```dotenv
GG_ADMIN_USERNAME=owner
GG_ADMIN_PASSWORD_HASH=scrypt$32768$8$1$...          # never the plaintext password
GG_CONTROL_SESSION_SECRET=...
GG_CONTROL_ENCRYPTION_KEY=...                        # back this up: stored account profiles need it
GG_CONTROL_PORT=8787
```

Also set the MySQL account. The `mysql` service creates it on its first start, and GoGon connects with
it. Compose refuses to start while `GG_MYSQL_PASSWORD` is empty.

```dotenv
GG_MYSQL_USER=gogon
GG_MYSQL_PASSWORD=...                                # a long random value; never reused elsewhere
GG_MYSQL_DATABASE=gogon
```

If any of these values is missing or invalid, or MySQL cannot be reached, the container exits before
the game login and never opens the dashboard port. It "fails closed".

## 2. Build and start

```sh
docker compose build
docker compose up -d
docker compose ps          # both services should become "healthy"; gogon waits for mysql
docker compose logs -f gogon
```

GoGon applies its schema migrations on start. The database starts empty.

## 3. Load the game reference data

Items, creatures, realms, and relics are not copied from the old SQLite database. Load them once
after the first start, and again whenever the game updates them:

```sh
docker compose run --rm gogon node scripts/populate_db.mjs
```

This replaces only the reference tables. Dedupe history, settings, account profiles, and the audit
log are kept. Until it runs, alerts show IDs where they would show item, creature, or realm names.

Once the catalog has projected anything (section 6), `populate_db.mjs` refuses to run unless you pass
`--discard-catalog-projections`, because a full replace would throw that work away. After that point,
prefer the Catalog tab's staged seed, which changes rows only through confirmed, reversible promotions.

What `compose.yaml` enforces:

| Control | Setting |
| --- | --- |
| Dashboard only on the host's loopback | `ports: "127.0.0.1:${GG_CONTROL_PORT}:${GG_CONTROL_PORT}"` |
| Non-root user | `user: node` (the image also ends with `USER node`) |
| Read-only root filesystem | `read_only: true`, with `/tmp` as a 64 MB tmpfs |
| Persistent state | MySQL named volume `gogon-mysql`; gogon itself has no writable app path |
| Private database | `mysql` has no `ports:` and joins only the `internal: true` network `db` |
| No Linux capabilities | `cap_drop: [ALL]`, `no-new-privileges:true` (mysql: `no-new-privileges:true`) |
| Health check | loopback probe `http://127.0.0.1:3000/health` inside the container (not published) |

## 4. Open the dashboard

On the Docker host itself, open `http://127.0.0.1:8787/`.

From another machine, use an SSH tunnel. Do not change the port mapping to `0.0.0.0`:

```sh
ssh -N -L 8787:127.0.0.1:8787 you@docker-host
# then open http://localhost:8787/ on your machine
```

The dashboard only answers to the host names `127.0.0.1:<port>`, `localhost:<port>`, and `[::1]:<port>`,
so keep the same port number on both ends of the tunnel. If you later put it behind HTTPS (a VPN or a reverse
proxy you control), set `GG_CONTROL_COOKIE_SECURE=1`.

## 5. Operating notes

- **Settings.** Every supported setting appears on the Settings tab with its source (`override`, `env`,
  or `default`) and reload mode. Hot settings apply on the next task run. Discord settings restart only the
  Discord client. `bootstrap` settings are `.env`-only: change them in `.env`, then run `docker compose up -d`.
- **Account profiles.** Credentials are encrypted with `GG_CONTROL_ENCRYPTION_KEY` (AES-256-GCM) and are never shown
  again. A switch pauses every module and flushes queued Discord messages, then signs in to the selected profile.
  Modules resume only after the sign-in is verified. If the sign-in fails, modules stay paused and no account
  is active until you retry or pick another profile.
- **Key rotation.** Stop GoGon. In `.env`, set `GG_CONTROL_ENCRYPTION_KEY_PREVIOUS` to the old key and
  `GG_CONTROL_ENCRYPTION_KEY` to a new one. Then run
  `docker compose run --rm gogon node scripts/control-plane/rotate-key.mjs`. It re-seals every secret in
  one MySQL transaction; if anything fails, nothing changes. Finally, remove the previous key and start
  GoGon again.
- **Backups.** No backup schedule is set up yet (an open decision). The database holds only ciphertext for
  credentials, tokens, and webhook URLs, so a dump is safe to store. Keep `GG_CONTROL_ENCRYPTION_KEY` in a
  separate safe place: a backup without the key cannot restore account profiles, and a key without the
  backup reveals nothing.
- **Audit log.** The Activity tab lists logins, denials, setting changes, and account switches. It records
  labels and keys only, never secret values.

## 6. Catalog (`catalog-sync-v1`)

The Catalog tab keeps items, creatures, realms, and master realms current. It records where each value
came from, and every change it makes to the tables Discord reads can be rolled back.

- **Browse.** Search by kind and name. Each item and creature shows `complete` or `incomplete` with
  the reasons. Complete means its guide page was read and every drop it lists is in the catalog. It
  never means no other drop exists.
- **Seed (optional, recommended first).** *Stage fsdatabase* downloads the same snapshot `populate_db.mjs`
  uses and records it without touching the serving tables. Promote each part in order: *Preview promotion*
  shows the exact row changes, and you type the phrase it shows to apply it. Promoted parts can be rolled
  back from *History & delete*.
- **Guide discovery.** The guide is read by your own browser, not by the server:
  1. In *Sync*, create a `guide_discovery` job (this enables it) and issue a relay token (1-7 days). Copy
     the token; it is shown once.
  2. Install `reconciliation/scrappers/gogon_guide_relay.user.js` in Tampermonkey. In the script's
     *Storage* tab set `gogonRelayToken` to the token (and `gogonRelayPort` if not 8787). The token is
     never typed into a web page.
  3. Open the SSH tunnel (section 4), open any `guide.fallensword.com` page, and press *Start* in the
     relay box.

  The relay asks GoGon what to read. It reads one page at a time, 3 s apart, at most 50 per lease and
  2,000 per day. Index page 0 is the newest, so a daily check stops shortly after it reaches IDs it
  already knows. A full sweep of about 1,279 pages runs weekly, or at once if the index is not in
  descending order. If Cloudflare asks for a check, the relay stops. Complete the check yourself, then
  press *Start*; it resumes at the same page. A kind shows *waiting for browser* when it is due and no
  relay has been seen for 30 minutes. It shows *overdue* after 48 hours. Revoke a token from *Sync* at
  any time.
- **Game jobs.** `observe_realm` needs one captured `fetchLocation` response before it can be enabled
  (DEC-CAT-019), so it is shown disabled with that reason. `item_frontier` needs a game item-detail read,
  which does not exist yet. The *CatalogSync* module on the Modules tab is off by default.
- **History & delete.** Every run can be previewed for rollback. The preview is valid for 10 minutes,
  can be used once, and needs its exact phrase. Rollback restores the previous values, or removes rows
  the run created.
