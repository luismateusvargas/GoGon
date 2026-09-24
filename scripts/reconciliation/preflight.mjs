// scripts/reconciliation/preflight.mjs - REC-TASK-001 / AC-REC-001
// Usage: node scripts/reconciliation/preflight.mjs [--write] [--root <dir>]
//   --write  regenerate reconciliation/manifest.json from the current trees
// Exits 1 when any differing or one-sided path lacks a current reviewed disposition.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, loadReview, scanTrees, serializeManifest } from './manifest.mjs';

const args = process.argv.slice(2);
const rootArg = args.indexOf('--root');
const rootDir = path.resolve(rootArg >= 0 ? args[rootArg + 1] : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
const reviewFile = path.join(rootDir, 'reconciliation', 'dispositions.json');
const manifestFile = path.join(rootDir, 'reconciliation', 'manifest.json');

const scan = await scanTrees({ rootDir });
const review = await loadReview(reviewFile);
const { manifest, failures, warnings } = evaluate(scan, review);

if (args.includes('--write')) {
    await writeFile(manifestFile, serializeManifest(manifest));
    console.log(`[reconcile] Wrote ${path.relative(rootDir, manifestFile)}`);
}

console.log(`[reconcile] ${manifest.summary.paths} differing/one-sided paths, ${manifest.summary.identical} identical.`);
console.log(`[reconcile] By disposition: ${JSON.stringify(manifest.summary.byDisposition)}`);
for (const w of warnings) console.warn(`[reconcile] WARN ${w.rule}: ${w.path} - ${w.detail}`);

if (failures.length) {
    for (const f of failures) {
        const entry = manifest.entries.find(e => e.path === f.path);
        const hashes = entry ? ` (backup=${entry.backupHash ?? '-'} root=${entry.rootHash ?? '-'})` : '';
        console.error(`[reconcile] FAIL ${f.rule}: ${f.path}${hashes} - ${f.detail}`);
    }
    console.error(`[reconcile] Preflight failed with ${failures.length} issue(s). Do not merge the listed paths.`);
    process.exitCode = 1;
} else {
    console.log('[reconcile] Preflight passed: every differing or one-sided path has a current reviewed disposition.');
}
