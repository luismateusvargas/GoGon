// control-plane/crypto.mjs - CTRL-TASK-002 / AC-CTRL-001, AC-CTRL-004
// AES-256-GCM for secrets at rest (keyed by GG_CONTROL_ENCRYPTION_KEY) and scrypt password hashes
// for GG_ADMIN_PASSWORD_HASH. Only node:crypto is used.
import crypto from 'node:crypto';

const CIPHER = 'aes-256-gcm';
const FORMAT = 'v1';

/** Decodes a base64 32-byte key; throws a message that never contains the key. */
export function parseKey(b64, name = 'GG_CONTROL_ENCRYPTION_KEY') {
    const key = typeof b64 === 'string' ? Buffer.from(b64.trim(), 'base64') : null;
    if (!key || key.length !== 32 || !/^[A-Za-z0-9+/]{43}=$/.test(b64.trim())) {
        throw new Error(`${name} must be 32 random bytes, base64-encoded (see scripts/control-plane/generate-secrets.mjs).`);
    }
    return key;
}

/** Short public fingerprint so ciphertext records which key sealed it (key rotation). */
export function keyId(key) {
    return crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);
}

/**
 * A keyring: seals with the current key, opens with the current or previous key.
 * `aad` binds a ciphertext to its record (e.g. "profile:<id>:email"), so ciphertexts cannot be swapped.
 */
export function createKeyring(currentB64, previousB64) {
    const current = parseKey(currentB64);
    const keys = new Map([[keyId(current), current]]);
    if (previousB64) {
        const prev = parseKey(previousB64, 'GG_CONTROL_ENCRYPTION_KEY_PREVIOUS');
        keys.set(keyId(prev), prev);
    }
    const currentId = keyId(current);

    return {
        currentKeyId: currentId,
        seal(plaintext, aad) {
            const iv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv(CIPHER, current, iv);
            cipher.setAAD(Buffer.from(aad, 'utf8'));
            const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
            return [FORMAT, currentId, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
        },
        open(sealed, aad) {
            const [format, kid, iv, tag, ct] = String(sealed).split(':');
            if (format !== FORMAT || !iv || !tag || ct === undefined) throw new Error('Unrecognized ciphertext format.');
            const key = keys.get(kid);
            if (!key) throw new Error('Ciphertext was sealed with an unknown key; set GG_CONTROL_ENCRYPTION_KEY_PREVIOUS to rotate.');
            const decipher = crypto.createDecipheriv(CIPHER, key, Buffer.from(iv, 'base64'));
            decipher.setAAD(Buffer.from(aad, 'utf8'));
            decipher.setAuthTag(Buffer.from(tag, 'base64'));
            try {
                return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
            } catch {
                throw new Error('Ciphertext failed authentication (wrong key or tampered record).');
            }
        },
        sealedWithCurrent(sealed) {
            return String(sealed).split(':')[1] === currentId;
        },
    };
}

// --- Password hashing (GG_ADMIN_PASSWORD_HASH) ---------------------------------------------------
// Format: scrypt$N$r$p$<salt b64>$<hash b64>. N=2^15, r=8, p=1 (about 32 MiB, well under maxmem).
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32 };

export function hashPassword(password) {
    if (typeof password !== 'string' || password.length < 12) throw new Error('Choose a password of at least 12 characters.');
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password.normalize('NFKC'), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
    return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

/** Constant-time verification. Malformed hashes simply fail. */
export async function verifyPassword(password, encoded) {
    const parts = String(encoded ?? '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt' || typeof password !== 'string') return false;
    const [N, r, p] = parts.slice(1, 4).map(Number);
    if (![N, r, p].every(Number.isInteger) || N < 16384 || N > 1048576 || r < 1 || r > 32 || p < 1 || p > 16) return false;
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    if (expected.length < 16) return false;
    const actual = await new Promise((resolve, reject) => crypto.scrypt(
        password.normalize('NFKC'), salt, expected.length, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 },
        (err, key) => (err ? reject(err) : resolve(key))));
    return crypto.timingSafeEqual(actual, expected);
}

export function randomToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString('base64url');
}

export function hmac(secret, data) {
    return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

export function safeEqual(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}
