// scripts/control-plane/demo-server.mjs - CTRL-TASK-007 browser acceptance harness.
// Serves the real dashboard against an in-process database (tests/helpers/fake-mysql.mjs), simulated modules, and a fake game
// login, so the UI can be exercised in a browser without the game, Discord, or the real .env.
//   node scripts/control-plane/demo-server.mjs [port]
// Sign in as "owner" with the password printed on start. Profiles whose password is "fail" fail to sign in.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../../_gg_data/handler/migrationRunner.js';
import { createMysqlClient } from '../../_gg_data/handler/mysqlClient.js';
import { fakeMysql2 } from '../../tests/helpers/fake-mysql.mjs';
import { createControlStore } from '../../_gg_data/handler/controlStore.js';
import { createKeyring, hashPassword, randomToken } from '../../control-plane/crypto.mjs';
import { createControlPlane } from '../../control-plane/server.mjs';
import { createAccountSwitcher } from '../../control-plane/accountSwitch.mjs';
import { loadOverrides } from '../../config/runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const port = Number(process.argv[2] || 8799);
const password = randomToken(12);

// The in-process MySQL stand-in from the test suite: nothing to install, nothing persists.
const db = createMysqlClient({ host: 'in-process', port: 0, database: 'demo' }, fakeMysql2);
await runMigrations(db, path.join(ROOT, '_gg_data', 'migrations'));
const store = createControlStore(db, createKeyring(crypto.randomBytes(32).toString('base64')));
loadOverrides(await store.loadOverrides());

// Simulated engine: modules "run" on their interval and occasionally fail.
const engineEvents = new EventEmitter();
let paused = false;
const modules = new Map(['SuperElites:15000', 'BountyBoard:5000', 'Crates:60000', 'Titans:60000', 'Ladder:60000', 'Shoutbox:300000',
    'GameUpdates:300000', 'Relics:60000', 'GuildConflicts:60000', 'Groups:60000', 'AutoGearSwap:60000', 'GuildMessages:300000']
    .map(s => s.split(':')).map(([name, ms]) => [name, { name, enabled: name !== 'AutoGearSwap', isActive: name !== 'AutoGearSwap', isRunning: false, interval: +ms, defaultInterval: +ms, lastRun: null }]));
setInterval(() => {
    for (const m of modules.values()) {
        if (!m.isActive || paused) continue;
        if (!m.lastRun || Date.now() - m.lastRun.startedAt >= Math.min(m.interval, 10_000)) {
            const failed = Math.random() < 0.1;
            m.lastRun = { startedAt: Date.now(), durationMs: 50 + Math.floor(Math.random() * 400), outcome: failed ? 'error' : 'ok', error: failed ? 'HTTP 503 from [url]' : null };
            engineEvents.emit('task', m.name);
        }
    }
}, 1000).unref();
const engine = {
    engineEvents,
    isPaused: () => paused,
    listModuleIds: () => [...modules.keys()],
    getTasksStatus: () => [...modules.values()].map(m => ({ ...m })),
    async setModuleEnabled(id, enabled) { Object.assign(modules.get(id), { enabled, isActive: enabled && !paused }); engineEvents.emit('task', id); },
    async setModuleInterval(id, ms) { modules.get(id).interval = ms; engineEvents.emit('task', id); },
    async pauseAll() { paused = true; const was = [...modules.values()].filter(m => m.enabled).map(m => m.name); for (const m of modules.values()) m.isActive = false; engineEvents.emit('engine', {}); return was; },
    async resumeAll(names) { paused = false; for (const n of names) { const m = modules.get(n); if (m?.enabled) m.isActive = true; } engineEvents.emit('engine', {}); return names; },
};

let signedIn = false;
const switcher = createAccountSwitcher({
    store, engine,
    drainQueue: async () => true,
    session: {
        setCredentialProvider: () => {},
        resetSession: async () => { signedIn = false; },
        login: async (email, pw) => { await new Promise(r => setTimeout(r, 800)); if (pw === 'fail') throw new Error('Authentication failed'); signedIn = true; },
        isLoggedIn: async () => signedIn,
    },
});

const cp = createControlPlane({
    config: { username: 'owner', passwordHash: hashPassword(password), sessionSecret: randomToken(32), host: '127.0.0.1', port, cookieSecure: false },
    store, engine, switcher,
    rebind: async () => { await new Promise(r => setTimeout(r, 300)); },
    healthReport: () => ({ status: 'ok' }),
    metrics: () => ({ demo: true }),
    validation: () => null,
});
await cp.listen(port, '127.0.0.1');
console.log(`Demo dashboard: http://127.0.0.1:${port}/  user: owner  password: ${password}`);
