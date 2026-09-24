// tests/reconciliation/manifest.test.mjs - REC-TASK-001 / AC-REC-001
// Fixture trees only: no network, no .env reads, backup/ is never written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    REQUIRED_RETAIN_ROOT, evaluate, exclusionReason, listFiles, scanTrees, serializeManifest,
} from '../../scripts/reconciliation/manifest.mjs';

const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha = text => createHash('sha256').update(text).digest('hex');
const FAKE_WEBHOOK = `https://discord.com/api/webhooks/123456789012345678/${'x'.repeat(68)}`;

async function makeFixture() {
    const dir = await mkdtemp(path.join(tmpdir(), 'gg-rec-'));
    const files = {
        'app.mjs': 'root app',
        'same.js': 'identical',
        'webhooks.js': 'export const hook = process.env.GG_HOOK;',
        '.env': 'GG_PASSWORD=do-not-read',
        'node_modules/pkg/index.js': 'dep',
        'obj/Debug/x.cache': 'build',
        'specs/a.spec.yaml': 'spec',
        '_gg_data/database/gg_data.db': 'live',
        '_gg_data/handler/gg_database.js': 'handler',
        'backup/app.mjs': 'backup app',
        'backup/same.js': 'identical',
        'backup/webhooks.js': `export const hook = '${FAKE_WEBHOOK}';`,
        'backup/.env': 'SWS_PASSWORD=do-not-read',
        'backup/legacy.bat': 'npm start',
        'backup/_sws_data/database/sws_data.db': 'legacy-db',
        'backup/_sws_data/database/sws_data.db-wal': 'wal',
    };
    for (const rel of REQUIRED_RETAIN_ROOT) files[rel] = `root-only ${rel}`;
    for (const [rel, body] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
        await writeFile(path.join(dir, rel), body);
    }
    return dir;
}

function reviewFor(scan, overrides = {}) {
    const defaults = {
        'app.mjs': { disposition: 'port', owners: ['REC-TASK-002'] },
        'webhooks.js': { disposition: 'retain-root' },
        'legacy.bat': { disposition: 'retire-legacy', owners: ['REC-TASK-006'] },
        '_sws_data/database/sws_data.db': { disposition: 'import-data', owners: ['REC-TASK-005'] },
    };
    const entries = {};
    for (const e of scan.entries) {
        entries[e.path] = {
            disposition: 'retain-root',
            ...defaults[e.path],
            reviewedBackupHash: e.backupHash,
            reviewedRootHash: e.rootHash,
            rationale: 'fixture review',
            ...overrides[e.path],
        };
    }
    return { reviewedOn: '2026-09-23', reviewer: 'test', entries };
}

test('AC-REC-001: records SHA-256 hashes for differing and one-sided paths only', async t => {
    const dir = await makeFixture();
    t.after(() => rm(dir, { recursive: true, force: true }));
    const scan = await scanTrees({ rootDir: dir });
    const byPath = Object.fromEntries(scan.entries.map(e => [e.path, e]));

    assert.equal(byPath['app.mjs'].status, 'differing');
    assert.equal(byPath['app.mjs'].rootHash, sha('root app'));
    assert.equal(byPath['app.mjs'].backupHash, sha('backup app'));
    assert.equal(byPath['legacy.bat'].status, 'backup-only');
    assert.equal(byPath['legacy.bat'].rootHash, null);
    assert.equal(byPath['metrics.mjs'].status, 'root-only');
    assert.equal(byPath['metrics.mjs'].backupHash, null);
    assert.deepEqual(scan.identical.map(i => i.path), ['same.js']);
    assert.ok(!byPath['same.js'], 'identical paths need no disposition');
});

test('AC-REC-001: excludes .env, node_modules, build output, live database and sidecars', async t => {
    const dir = await makeFixture();
    t.after(() => rm(dir, { recursive: true, force: true }));
    const scan = await scanTrees({ rootDir: dir });
    const paths = [...scan.entries, ...scan.identical].map(e => e.path);

    for (const excluded of ['.env', 'node_modules/pkg/index.js', 'obj/Debug/x.cache', 'specs/a.spec.yaml',
        '_gg_data/database/gg_data.db', '_sws_data/database/sws_data.db-wal']) {
        assert.ok(!paths.includes(excluded), `${excluded} must not be in the manifest`);
    }
    assert.ok(paths.every(p => !p.startsWith('backup/')), 'root scan must not descend into backup/');
    assert.ok(paths.includes('_sws_data/database/sws_data.db'), 'frozen legacy database is import evidence');
    assert.equal(exclusionReason('.env', 'backup'), 'secret-env');
    assert.equal(exclusionReason('.env.local', 'root'), 'secret-env');
    assert.equal(exclusionReason('config/.env.production', 'root'), 'secret-env');
});

test('AC-REC-001: a complete current review passes and root-only capabilities are retain-root', async t => {
    const dir = await makeFixture();
    t.after(() => rm(dir, { recursive: true, force: true }));
    const scan = await scanTrees({ rootDir: dir });
    const { manifest, failures } = evaluate(scan, reviewFor(scan));

    assert.deepEqual(failures, []);
    for (const rel of [...REQUIRED_RETAIN_ROOT, '_gg_data/handler/gg_database.js']) {
        assert.equal(manifest.entries.find(e => e.path === rel).disposition, 'retain-root', rel);
    }
    assert.ok(manifest.entries.every(e => e.reviewState === 'reviewed'));
});

test('AC-REC-001: required root-only capabilities cannot be given another disposition', async t => {
    const dir = await makeFixture();
    t.after(() => rm(dir, { recursive: true, force: true }));
    const scan = await scanTrees({ rootDir: dir });
    const review = reviewFor(scan, {
        'healthCheck.mjs': { disposition: 'retire-legacy', owners: ['X'] },
        '_gg_data/handler/gg_database.js': { disposition: 'port', owners: ['X'] },
    });
    const rules = evaluate(scan, review).failures.map(f => `${f.rule}:${f.path}`);
    assert.ok(rules.includes('required-retain-root:healthCheck.mjs'));
    assert.ok(rules.includes('required-retain-root:_gg_data/handler/gg_database.js'));
});

test('AC-REC-001: unreviewed and invalid dispositions fail the preflight', async t => {
    const dir = await makeFixture();
    t.after(() => rm(dir, { recursive: true, force: true }));
    const scan = await scanTrees({ rootDir: dir });
    const review = reviewFor(scan, { 'legacy.bat': { disposition: 'copy' } });
    delete review.entries['app.mjs'];
    const rules = evaluate(scan, review).failures.map(f => `${f.rule}:${f.path}`);
    assert.ok(rules.includes('unreviewed:app.mjs'));
    assert.ok(rules.includes('invalid-disposition:legacy.bat'));
});

test('AC-REC-001 error case: a path changed after review is stale until re-reviewed', async t => {
    const dir = await makeFixture();
    t.after(() => rm(dir, { recursive: true, force: true }));
    const review = reviewFor(await scanTrees({ rootDir: dir }));

    await writeFile(path.join(dir, 'backup', 'app.mjs'), 'backup app edited after review');
    const rescan = await scanTrees({ rootDir: dir });
    const { manifest, failures } = evaluate(rescan, review);
    assert.deepEqual(failures.map(f => `${f.rule}:${f.path}`), ['stale-review:app.mjs']);
    assert.equal(manifest.entries.find(e => e.path === 'app.mjs').reviewState, 'stale');
    assert.equal(manifest.entries.find(e => e.path === 'app.mjs').backupHash, sha('backup app edited after review'));

    // Repeating the review for that path with the regenerated hashes clears the failure.
    const again = reviewFor(rescan);
    assert.deepEqual(evaluate(rescan, again).failures, []);
});

test('AC-REC-001: secret-bearing files are flagged, never ported, and their contents never recorded', async t => {
    const dir = await makeFixture();
    t.after(() => rm(dir, { recursive: true, force: true }));
    const scan = await scanTrees({ rootDir: dir });
    assert.equal(scan.entries.find(e => e.path === 'webhooks.js').secretBearing, true);

    const bad = evaluate(scan, reviewFor(scan, { 'webhooks.js': { disposition: 'port', owners: ['REC-TASK-002'] } }));
    assert.ok(bad.failures.some(f => f.rule === 'secret-port' && f.path === 'webhooks.js'));

    const text = serializeManifest(evaluate(scan, reviewFor(scan)).manifest);
    assert.ok(!text.includes('discord.com/api/webhooks'), 'manifest must not contain webhook URLs');
    assert.ok(!text.includes('do-not-read'), 'manifest must not contain .env values');
});

test('AC-REC-001: one-sided dispositions must match the side that exists', async t => {
    const dir = await makeFixture();
    t.after(() => rm(dir, { recursive: true, force: true }));
    const scan = await scanTrees({ rootDir: dir });
    const review = reviewFor(scan, { 'legacy.bat': { disposition: 'retain-root' } });
    review.entries['_sws_data/database/sws_data.db'].owners = [];
    const rules = evaluate(scan, review).failures.map(f => `${f.rule}:${f.path}`);
    assert.ok(rules.includes('backup-only-retained:legacy.bat'));
    assert.ok(rules.includes('missing-owner:_sws_data/database/sws_data.db'));
});

test('AC-REC-001: the manifest is reproducible byte-for-byte', async t => {
    const dir = await makeFixture();
    t.after(() => rm(dir, { recursive: true, force: true }));
    const first = await scanTrees({ rootDir: dir });
    const review = reviewFor(first);
    const a = serializeManifest(evaluate(first, review).manifest);
    const b = serializeManifest(evaluate(await scanTrees({ rootDir: dir }), review).manifest);
    assert.equal(a, b);
});

// backup/ is Git-ignored and local-only, so CI (tracked code only) skips this check. Owner decision 2026-09-24.
const HAS_BACKUP = existsSync(path.join(WORKSPACE, 'backup'));
test('AC-REC-001 workspace: reviewed dispositions cover the real trees and the manifest is current', { skip: !HAS_BACKUP && 'backup/ is local-only; reconciliation runs outside CI' }, async () => {
    const backupDir = path.join(WORKSPACE, 'backup');
    const backupFiles = await listFiles(backupDir, 'backup');
    const before = await Promise.all(backupFiles.map(async f => sha(await readFile(path.join(backupDir, f)))));

    const scan = await scanTrees({ rootDir: WORKSPACE });
    const review = JSON.parse(await readFile(path.join(WORKSPACE, 'reconciliation', 'dispositions.json'), 'utf8'));
    const { manifest, failures } = evaluate(scan, review);
    assert.deepEqual(failures, [], 'run `npm run reconcile:preflight` for details, then re-review changed paths');

    const committed = await readFile(path.join(WORKSPACE, 'reconciliation', 'manifest.json'), 'utf8');
    assert.equal(committed, serializeManifest(manifest), 'regenerate with `npm run reconcile:manifest`');
    assert.ok(manifest.entries.every(e => !/(^|\/)\.env/.test(e.path) && !e.path.includes('node_modules/')));

    const after = await Promise.all(backupFiles.map(async f => sha(await readFile(path.join(backupDir, f)))));
    assert.deepEqual(after, before, 'backup/ must remain read-only evidence');
});
