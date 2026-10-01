// Runs Chromium only when the guide needs a fresh clearance. The child never writes its
// browser profile or clearance to application storage; stdout is a private JSON response.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CLEARANCE_PATTERN = /^[A-Za-z0-9._-]{1,4096}$/;
const RENEWAL_TIMEOUT_MS = 100_000;

export class GuideClearanceError extends Error {
    constructor(message) {
        super(message);
        this.name = 'GuideClearanceError';
    }
}

/** The only value crossing this process boundary is a short-lived cookie and its browser User-Agent. */
export async function renewGuideClearance({ signal, execFileFn = execFileAsync } = {}) {
    let output;
    try {
        ({ stdout: output } = await execFileFn('xvfb-run', [
            '-a', '-s', '-screen 0 1280x900x24',
            '/opt/gogon-guide-python/bin/python', '/app/scripts/control-plane/renew-guide-clearance.py',
        ], { encoding: 'utf8', maxBuffer: 16 * 1024, timeout: RENEWAL_TIMEOUT_MS, signal }));
    } catch {
        throw new GuideClearanceError('Guide browser verification did not complete.');
    }
    let credentials;
    try {
        credentials = JSON.parse(output);
    } catch {
        throw new GuideClearanceError('Guide browser returned an invalid response.');
    }
    if (typeof credentials?.clearance !== 'string' || !CLEARANCE_PATTERN.test(credentials.clearance)
        || typeof credentials?.userAgent !== 'string' || !credentials.userAgent.length
        || credentials.userAgent.length > 300 || /[\r\n\x00-\x1f\x7f]/.test(credentials.userAgent)) {
        throw new GuideClearanceError('Guide browser returned invalid credentials.');
    }
    return credentials;
}
