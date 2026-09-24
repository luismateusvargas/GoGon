// tests/control-plane/boot-fail-closed.test.mjs - CTRL-TASK-005/006 / AC-CTRL-005 error case, AC-DATA-007 error case
// app.mjs must exit 1 before any game login and without opening a control port when (a) the control
// plane is enabled but its bootstrap values are missing, or (b) MySQL is unreachable. The child runs
// with the no-network guard and DOTENV_CONFIG_PATH pointing away from the real .env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function boot(extraEnv, preload) {
    const dir = mkdtempSync(path.join(tmpdir(), 'gg-boot-'));
    const env = {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
        DOTENV_CONFIG_PATH: path.join(dir, 'no-such.env'), DOTENV_CONFIG_QUIET: 'true',
        GG_EMAIL: 'boot@example.test', GG_PASSWORD: 'boot-password-fixture', GG_BOT_CHARACTER: 'Bot', GG_BOT_ID_CHARACTER: '1',
        GG_HEALTH_CHECK_ENABLED: '0',
        ...extraEnv,
    };
    const args = ['--import', './tests/helpers/no-network.mjs', ...preload, 'app.mjs'];
    const r = spawnSync(process.execPath, args, { cwd: path.resolve('.'), env, encoding: 'utf8', timeout: 60_000 });
    return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

// The child uses the same database as the tests: the in-process fake, or GG_TEST_MYSQL_URL in CI.
const testDatabase = ['--experimental-test-module-mocks', '--import', './tests/helpers/test-database.mjs'];
const passThrough = process.env.GG_TEST_MYSQL_URL ? { GG_TEST_MYSQL_URL: process.env.GG_TEST_MYSQL_URL } : {};

test('AC-CTRL-005: missing admin bootstrap values stop the boot before game login', () => {
    const { status, out } = boot({ ...passThrough, GG_CONTROL_ENABLED: '1', GG_CONTROL_PORT: '0' }, testDatabase);
    assert.equal(status, 1, out);
    assert.match(out, /Control plane bootstrap is incomplete: GG_ADMIN_USERNAME is not set/);
    assert.doesNotMatch(out, /Performing initial login/, 'no game login attempted');
    assert.doesNotMatch(out, /Control plane listening/, 'no control port opened');
    assert.doesNotMatch(out, /Live network access blocked/, 'nothing tried to reach the network');
    assert.ok(!out.includes('boot-password-fixture'));
});

test('AC-DATA-007 error case: an unreachable MySQL stops the boot before game login, without the password', () => {
    const { status, out } = boot({
        GG_MYSQL_HOST: '127.0.0.1', GG_MYSQL_PORT: '1', GG_MYSQL_PASSWORD: 'mysql-password-fixture',
    }, []);
    assert.equal(status, 1, out);
    assert.match(out, /Database unavailable: \[GG_DB\] MySQL at 127\.0\.0\.1:1 is unreachable \(ECONNREFUSED\)/);
    assert.doesNotMatch(out, /Performing initial login/, 'no game login attempted');
    assert.ok(!out.includes('mysql-password-fixture'), 'the MySQL password is never printed');
});

test('AC-DATA-007 error case: a missing MySQL password stops the boot by name', () => {
    const { status, out } = boot({ GG_MYSQL_HOST: '127.0.0.1', GG_MYSQL_PORT: '1' }, []);
    assert.equal(status, 1, out);
    assert.match(out, /Database unavailable: \[GG_DB\] GG_MYSQL_PASSWORD is not set/);
    assert.doesNotMatch(out, /Performing initial login/);
});
