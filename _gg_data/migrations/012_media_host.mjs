// Move stored item and creature images to cdn2.fallensword.com. cdn.fallensword.com now serves a
// Cloudflare challenge, so Discord embeds (Super Elite, Titan, crate) showed no image. Idempotent:
// rows already on the working host no longer match.
import { canonicalImageUrl, MEDIA_BASE } from '../handler/mediaUrl.js';

export async function up(client) {
    for (const table of ['items', 'creatures']) {
        const rows = await client.query(
            `SELECT id, imageUrl FROM ${table} WHERE imageUrl LIKE '%//cdn.fallensword.com/%' OR imageUrl LIKE 'http://cdn2.fallensword.com/%'`);
        for (const { id, imageUrl } of rows) {
            const url = canonicalImageUrl(imageUrl);
            if (url !== imageUrl) await client.query(`UPDATE ${table} SET imageUrl = ? WHERE id = ?`, [url, id]);
        }
        if (rows.length) console.log(`[GG_DB] Moved ${rows.length} ${table} image URL(s) to ${MEDIA_BASE}.`);
    }
}
