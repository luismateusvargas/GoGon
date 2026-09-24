// scripts/control-plane/generate-secrets.mjs - CTRL-TASK-001
// Prints fresh GG_CONTROL_SESSION_SECRET and GG_CONTROL_ENCRYPTION_KEY lines for .env.
// Paste them into .env yourself; this script never reads or writes .env.
//   node scripts/control-plane/generate-secrets.mjs
import crypto from 'node:crypto';

console.log(`GG_CONTROL_SESSION_SECRET=${crypto.randomBytes(48).toString('base64url')}`);
console.log(`GG_CONTROL_ENCRYPTION_KEY=${crypto.randomBytes(32).toString('base64')}`);
console.error('# Keep GG_CONTROL_ENCRYPTION_KEY safe: without it, stored account profiles cannot be decrypted.');
