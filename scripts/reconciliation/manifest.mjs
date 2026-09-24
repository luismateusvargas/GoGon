// scripts/reconciliation/manifest.mjs - REC-TASK-001 / AC-REC-001
// Builds a reproducible SHA-256 manifest of backup/ vs the GoGon root and checks it
// against the reviewed dispositions. backup/ is read-only evidence: this module only
// reads files and never copies, merges, or prints file contents.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const DISPOSITIONS = Object.freeze(['port', 'retain-root', 'import-data', 'retire-legacy']);

// Root-only capabilities that REC-TASK-001 requires to be classified retain-root.
export const REQUIRED_RETAIN_ROOT = Object.freeze([
    'configValidator.mjs',
    'healthCheck.mjs',
    'metrics.mjs',
    'app_modules/constants.js',
    'scripts/populate_db.mjs',
]);
export const REQUIRED_RETAIN_ROOT_PREFIXES = Object.freeze(['_gg_data/']);

// Directory names excluded at any depth: dependencies, build output, IDE and VCS state.
const EXCLUDED_DIR_NAMES = new Set([
    'node_modules', 'obj', 'bin', 'dist', 'build', 'out', 'coverage',
    'DEBUG', '.git', '.vs', '.vscode', '.idea',
]);

// Root-relative prefixes that are not application paths (specs, docs, and this tooling).
const EXCLUDED_ROOT_PREFIXES = ['backup/', 'specs/', 'tests/', 'reconciliation/', 'scripts/reconciliation/'];
const EXCLUDED_ROOT_FILES = new Set(['CHANGELOG.md']);

/**
 * Returns the exclusion reason for a relative POSIX path, or null when it is in scope.
 * Exclusions are applied before any file is opened, so .env files are never read.
 * @param {string} rel - Path relative to its tree root.
 * @param {'root'|'backup'} side
 */
export function exclusionReason(rel, side) {
    const parts = rel.split('/');
    const base = parts[parts.length - 1];
    if (parts.slice(0, -1).some(p => EXCLUDED_DIR_NAMES.has(p))) return 'generated-or-dependency';
    if (base === '.env' || base.startsWith('.env.')) return 'secret-env';
    if (/\.db-(shm|wal|journal)$/.test(base)) return 'database-sidecar';
    if (/\.log$/.test(base) || base === 'Thumbs.db' || base === '.DS_Store') return 'generated-or-dependency';
    if (side === 'root') {
        if (EXCLUDED_ROOT_PREFIXES.some(p => rel.startsWith(p))) return 'non-application';
        if (EXCLUDED_ROOT_FILES.has(rel)) return 'non-application';
        // The active database is live runtime state; REC-TASK-005 owns it through snapshots.
        if (/^_gg_data\/database\/[^/]+\.db$/.test(rel)) return 'live-database';
        // Pre-import and pre-rollback copies written by import-legacy-db.mjs (REC-TASK-005).
        if (/^_gg_data\/database\/snapshots\/[^/]+\.db$/.test(rel)) return 'database-snapshot';
    }
    return null;
}

/** Lists in-scope files of a tree as sorted relative POSIX paths. Symlinks are not followed. */
export async function listFiles(treeRoot, side) {
    const out = [];
    async function walk(dirRel) {
        const entries = await readdir(path.join(treeRoot, dirRel), { withFileTypes: true });
        for (const entry of entries) {
            const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) {
                if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
                if (side === 'root' && EXCLUDED_ROOT_PREFIXES.includes(`${rel}/`)) continue;
                await walk(rel);
            } else if (entry.isFile() && !exclusionReason(rel, side)) {
                out.push(rel);
            }
        }
    }
    await walk('');
    return out.sort();
}

export function sha256File(file) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        createReadStream(file)
            .on('error', reject)
            .on('data', chunk => hash.update(chunk))
            .on('end', () => resolve(hash.digest('hex')));
    });
}

// Hardcoded credentials that must never be ported. Only a boolean is recorded.
const SECRET_PATTERNS = [
    /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/,
    /\b[MNO][\w-]{23,27}\.[\w-]{6}\.[\w-]{27,40}\b/, // Discord bot token shape
];
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.bat', '.cmd', '.ps1', '.sh', '.sql', '.yaml', '.yml', '.txt', '.md', '.esproj', '.props', '']);

export async function isSecretBearing(file) {
    const ext = path.extname(file).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext) && path.basename(file) !== '.gitignore') return false;
    const text = await readFile(file, 'utf8');
    return SECRET_PATTERNS.some(re => re.test(text));
}

async function describeSide(treeRoot, rel) {
    const file = path.join(treeRoot, rel);
    const stat = await lstat(file);
    return {
        hash: await sha256File(file),
        size: stat.size,
        secretBearing: await isSecretBearing(file),
    };
}

/**
 * Scans both trees and returns differing and one-sided paths plus identical paths.
 * @param {{ rootDir: string, backupDir?: string }} opts
 */
export async function scanTrees({ rootDir, backupDir = path.join(rootDir, 'backup') }) {
    const [rootFiles, backupFiles] = await Promise.all([
        listFiles(rootDir, 'root'),
        listFiles(backupDir, 'backup'),
    ]);
    const all = [...new Set([...rootFiles, ...backupFiles])].sort();
    const rootSet = new Set(rootFiles);
    const backupSet = new Set(backupFiles);

    const entries = [];
    const identical = [];
    for (const rel of all) {
        const root = rootSet.has(rel) ? await describeSide(rootDir, rel) : null;
        const backup = backupSet.has(rel) ? await describeSide(backupDir, rel) : null;
        let status;
        if (root && backup) status = root.hash === backup.hash ? 'identical' : 'differing';
        else status = root ? 'root-only' : 'backup-only';
        if (status === 'identical') {
            identical.push({ path: rel, hash: root.hash });
            continue;
        }
        entries.push({
            path: rel,
            status,
            backupHash: backup?.hash ?? null,
            rootHash: root?.hash ?? null,
            backupSize: backup?.size ?? null,
            rootSize: root?.size ?? null,
            secretBearing: Boolean(root?.secretBearing || backup?.secretBearing),
        });
    }
    return { entries, identical };
}

export async function loadReview(file) {
    return JSON.parse(await readFile(file, 'utf8'));
}

function requiresRetainRoot(rel) {
    return REQUIRED_RETAIN_ROOT.includes(rel) || REQUIRED_RETAIN_ROOT_PREFIXES.some(p => rel.startsWith(p));
}

/**
 * Joins a scan with reviewed dispositions and evaluates the AC-REC-001 preflight rules.
 * A path is merge-ready only when its reviewed hashes equal the current hashes.
 * @returns {{ manifest: object, failures: object[], warnings: object[] }}
 */
export function evaluate(scan, review) {
    const reviewed = review?.entries ?? {};
    const failures = [];
    const warnings = [];
    const fail = (rel, rule, detail) => failures.push({ path: rel, rule, detail });

    const entries = scan.entries.map(entry => {
        const r = reviewed[entry.path];
        let reviewState = 'reviewed';
        if (!r) {
            reviewState = 'unreviewed';
            fail(entry.path, 'unreviewed', `No reviewed disposition for ${entry.status} path.`);
        } else {
            if (!DISPOSITIONS.includes(r.disposition)) {
                fail(entry.path, 'invalid-disposition', `Disposition must be one of ${DISPOSITIONS.join(', ')}.`);
            }
            if ((r.reviewedBackupHash ?? null) !== entry.backupHash || (r.reviewedRootHash ?? null) !== entry.rootHash) {
                reviewState = 'stale';
                fail(entry.path, 'stale-review',
                    'Path changed after review; regenerate the manifest and repeat the review before merging it.');
            }
            if (!r.rationale || !String(r.rationale).trim()) {
                fail(entry.path, 'missing-rationale', 'Reviewed dispositions must record a rationale.');
            }
            if (r.disposition !== 'retain-root' && !(Array.isArray(r.owners) && r.owners.length)) {
                fail(entry.path, 'missing-owner', `A ${r.disposition} disposition must name its owning task(s).`);
            }
            if (entry.status === 'root-only' && r.disposition !== 'retain-root') {
                fail(entry.path, 'root-only-not-retained', 'Root-only paths have no backup source and must be retain-root.');
            }
            if (entry.status === 'backup-only' && r.disposition === 'retain-root') {
                fail(entry.path, 'backup-only-retained', 'A backup-only path cannot be retained from root.');
            }
            if (entry.secretBearing && r.disposition === 'port') {
                fail(entry.path, 'secret-port', 'A secret-bearing path may not be ported; source secrets from configuration.');
            }
            if (requiresRetainRoot(entry.path) && r.disposition !== 'retain-root') {
                fail(entry.path, 'required-retain-root', 'REC-TASK-001 requires this root capability to be retain-root.');
            }
        }
        return {
            path: entry.path,
            status: entry.status,
            backupHash: entry.backupHash,
            rootHash: entry.rootHash,
            disposition: r?.disposition ?? null,
            reviewState,
            secretBearing: entry.secretBearing,
            owners: r?.owners ?? [],
            rationale: r?.rationale ?? null,
            ...(r?.portCandidates ? { portCandidates: r.portCandidates } : {}),
            ...(r?.doNotPort ? { doNotPort: r.doNotPort } : {}),
        };
    });

    const scanned = new Set(scan.entries.map(e => e.path));
    for (const rel of REQUIRED_RETAIN_ROOT) {
        if (!scanned.has(rel)) fail(rel, 'required-path-missing', 'Required root-only capability is missing from the root tree.');
    }
    for (const rel of Object.keys(reviewed)) {
        if (!scanned.has(rel)) {
            warnings.push({ path: rel, rule: 'orphan-review', detail: 'Reviewed path is now identical, excluded, or absent.' });
        }
    }

    const counts = {};
    for (const e of entries) {
        const key = e.disposition ?? 'unreviewed';
        counts[key] = (counts[key] ?? 0) + 1;
    }

    const manifest = {
        schemaVersion: 1,
        spec: 'backup-reconciliation-v1',
        task: 'REC-TASK-001',
        acceptance: 'AC-REC-001',
        hashAlgorithm: 'sha256',
        review: { reviewedOn: review?.reviewedOn ?? null, reviewer: review?.reviewer ?? null },
        summary: {
            paths: entries.length,
            identical: scan.identical.length,
            byDisposition: Object.fromEntries(Object.entries(counts).sort()),
            failures: failures.length,
        },
        entries,
        identical: scan.identical,
    };
    return { manifest, failures, warnings };
}

/** Deterministic serialization: same trees and review produce byte-identical output. */
export function serializeManifest(manifest) {
    return `${JSON.stringify(manifest, null, 2)}\n`;
}
