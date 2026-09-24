// scripts/control-plane/rotate-key.mjs - CTRL-TASK-002 key rotation procedure (MySQL since DATA-TASK-007).
//   1. Stop GoGon (docker compose stop gogon).
//   2. In .env, move the current key to GG_CONTROL_ENCRYPTION_KEY_PREVIOUS and put a new key
//      (scripts/control-plane/generate-secrets.mjs) in GG_CONTROL_ENCRYPTION_KEY.
//   3. docker compose run --rm gogon node scripts/control-plane/rotate-key.mjs
//      (every profile and secret override is re-sealed with the new key in one MySQL transaction;
//      a failure rolls back and leaves the old ciphertext untouched)
//   4. Remove GG_CONTROL_ENCRYPTION_KEY_PREVIOUS from .env and start GoGon.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKeyring } from '../../control-plane/crypto.mjs';
import { createControlStore } from '../../_gg_data/handler/controlStore.js';
import { getConnection, closeDatabase } from '../../_gg_data/handler/gg_database.js';

const SELF = fileURLToPath(import.meta.url);

/**
 * @param {{ currentKey: string, previousKey: string, client?: object }} opts - client defaults to the
 *   migrated GoGon MySQL client (gg_database getConnection()).
 * @returns {Promise<{ profiles: number, overrides: number }>}
 */
export async function rotateEncryptionKey({ currentKey, previousKey, client }) {
    if (!previousKey) throw new Error('Set GG_CONTROL_ENCRYPTION_KEY_PREVIOUS to the old key before rotating.');
    const keyring = createKeyring(currentKey, previousKey);
    return createControlStore(client ?? await getConnection(), keyring).reencryptAll();
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
    rotateEncryptionKey({
        currentKey: process.env.GG_CONTROL_ENCRYPTION_KEY,
        previousKey: process.env.GG_CONTROL_ENCRYPTION_KEY_PREVIOUS,
    }).then(r => {
        console.log(`[rotate-key] Re-sealed ${r.profiles} profile(s) and ${r.overrides} secret override(s).`);
        console.log('[rotate-key] Now remove GG_CONTROL_ENCRYPTION_KEY_PREVIOUS from .env.');
    }).catch(e => { console.error(`[rotate-key] ${e.message}`); process.exitCode = 1; })
        .finally(() => closeDatabase());
}
