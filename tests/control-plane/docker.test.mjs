// tests/control-plane/docker.test.mjs - CTRL-TASK-006/007 / AC-CTRL-005
// Static checks of the container security options (Docker is not required to run the suite).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = f => fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const strip = s => s.replace(/#.*$/gm, '');

test('AC-CTRL-005: the image is pinned Node 22, installs from the lockfile, and runs as non-root', () => {
    const df = strip(read('Dockerfile'));
    const froms = [...df.matchAll(/^FROM\s+(\S+)/gm)].map(m => m[1]);
    assert.ok(froms.length >= 1);
    assert.match(df, /ARG NODE_IMAGE=node:22\.\d+\.\d+-[a-z]+-slim(@sha256:[0-9a-f]{64})?\n/, 'exact Node 22 version tag');
    assert.doesNotMatch(df, /:latest\b|node:22\s|node:lts/);
    assert.match(df, /npm ci --omit=dev/);
    assert.match(df, /^USER node$/m);
    assert.match(df, /^HEALTHCHECK /m);
    assert.match(df, /127\.0\.0\.1/);
});

test('AC-CTRL-005: compose publishes loopback only and applies the hardening options', () => {
    const c = strip(read('compose.yaml'));
    const ports = [...c.matchAll(/^\s+-\s+"([^"]+)"\s*$/gm)].map(m => m[1]).filter(p => /:\$\{GG_CONTROL_PORT/.test(p));
    assert.deepEqual(ports, ['127.0.0.1:${GG_CONTROL_PORT:-8787}:${GG_CONTROL_PORT:-8787}']);
    assert.doesNotMatch(c, /^\s+-\s+"?(0\.0\.0\.0:)?\d+:\d+"?\s*$/m, 'no port published on all interfaces');
    assert.doesNotMatch(c, /network_mode:\s*host|privileged:\s*true/);
    for (const needle of [/read_only:\s*true/, /cap_drop:\s*\n\s+-\s+ALL/, /no-new-privileges:true/, /user:\s*"node"/,
        /tmpfs:\s*\n\s+-\s+\/tmp/, /healthcheck:/, /GG_CONTROL_ENABLED:\s*"1"/]) {
        assert.match(c, needle);
    }
    assert.match(c, /GG_HEALTH_CHECK_HOST:\s*"127\.0\.0\.1"/, 'probe stays on container loopback');
    assert.doesNotMatch(c, /_gg_data\/database|GG_DB_DIR/, 'no SQLite volume or path is left');
});

/** The indented block of one compose service, e.g. service(c, 'mysql'). */
function service(compose, name) {
    const m = compose.match(new RegExp(`^  ${name}:\\n((?:    .*\\n|\\s*\\n)*)`, 'm'));
    assert.ok(m, `service ${name}`);
    return m[1];
}

test('AC-DATA-007 / DATA-TASK-008: MySQL is bundled, private, persistent, and required before gogon starts', () => {
    const c = strip(read('compose.yaml'));
    const mysql = service(c, 'mysql');
    const gogon = service(c, 'gogon');
    assert.match(mysql, /image:\s*mysql:8\.4\b/);
    assert.doesNotMatch(mysql, /^\s+ports:/m, 'mysql publishes no port');
    assert.match(mysql, /networks:\s*\n\s+-\s+db\s*\n/, 'mysql joins only the db network');
    assert.match(c, /^networks:\s*\n\s+db:\s*\n\s+internal:\s*true/m, 'the db network has no outside route');
    assert.match(mysql, /gogon-mysql:\/var\/lib\/mysql/);
    assert.match(c, /^volumes:\s*\n\s+gogon-mysql:/m);
    assert.match(mysql, /MYSQL_PASSWORD:\s*"\$\{GG_MYSQL_PASSWORD:\?[^}]+\}"/, 'compose refuses to start without a password');
    assert.match(mysql, /MYSQL_RANDOM_ROOT_PASSWORD:\s*"yes"/);
    assert.match(mysql, /collation-server=utf8mb4_bin/, 'exact, case-sensitive keys');
    assert.match(mysql, /no-new-privileges:true/);
    assert.match(mysql, /healthcheck:/);
    assert.doesNotMatch(mysql, /mysqladmin[^\n]*-p/, 'the password is not on the healthcheck command line');
    assert.match(gogon, /depends_on:\s*\n\s+mysql:\s*\n\s+condition:\s*service_healthy/);
    assert.match(gogon, /GG_MYSQL_HOST:\s*mysql\b/);
    assert.match(gogon, /networks:\s*\n\s+-\s+default\s*\n\s+-\s+db\s*\n/);
});

test('DATA-TASK-008/010: the image has no native build toolchain and SQLite is absent from project dependencies', () => {
    const df = strip(read('Dockerfile'));
    assert.doesNotMatch(df, /apt-get|g\+\+|python3/);
    const pkg = JSON.parse(read('package.json'));
    assert.ok(pkg.dependencies.mysql2);
    assert.equal(pkg.dependencies['better-sqlite3'], undefined);
    assert.equal(pkg.devDependencies?.['better-sqlite3'], undefined);
});

test('CTRL-TASK-006: secrets and local state are excluded from the build context', () => {
    const ignore = read('.dockerignore').split(/\r?\n/).map(l => l.trim());
    for (const entry of ['.env', '.env.*', 'cookies.bootstrap.json', 'node_modules', '_gg_data/database', 'backup', 'DEBUG']) {
        assert.ok(ignore.includes(entry), entry);
    }
});

test('CTRL-TASK-006: deployment docs give loopback-only SSH tunnel instructions', () => {
    const doc = read('docs/deployment.md');
    assert.match(doc, /ssh -N -L 8787:127\.0\.0\.1:8787/);
    assert.match(doc, /hash-password\.mjs/);
    assert.doesNotMatch(doc, /GG_ADMIN_PASSWORD_HASH=[^s\n]/, 'no plaintext password example');
});
