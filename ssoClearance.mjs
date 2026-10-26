// Obtain HuntedCow clearance in the same VPS Chromium environment used by guide discovery.
// The helper receives no account credentials and never persists its browser profile.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const COOKIE_VALUE = /^[A-Za-z0-9._-]{1,4096}$/;
const TIMEOUT_MS = 100_000;
const COOKIE_NAMES = new Set(['cf_clearance', 'hcs_session_key']);

export class SsoClearanceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SsoClearanceError';
  }
}

/** Return browser-issued HuntedCow cookies and the matching User-Agent after verification. */
export async function renewSsoClearance({ entryUrl = 'https://huntedcow.com/auth?game=6', signal, execFileFn = execFileAsync } = {}) {
  const url = new URL(entryUrl);
  if (url.protocol !== 'https:' || !['huntedcow.com', 'account.huntedcow.com'].includes(url.hostname)
      || url.pathname !== '/auth') throw new SsoClearanceError('Invalid HuntedCow SSO entry URL.');
  let output;
  try {
    ({ stdout: output } = await execFileFn('xvfb-run', [
      '-a', '-s', '-screen 0 1280x900x24',
      '/opt/gogon-guide-python/bin/python', '/app/scripts/control-plane/renew-sso-clearance.py', url.toString(),
    ], { encoding: 'utf8', maxBuffer: 16 * 1024, timeout: TIMEOUT_MS, signal }));
  } catch {
    throw new SsoClearanceError('HuntedCow browser verification did not complete.');
  }

  let result;
  try {
    result = JSON.parse(output);
  } catch {
    throw new SsoClearanceError('HuntedCow browser returned an invalid response.');
  }
  if (typeof result?.userAgent !== 'string' || !result.userAgent.length || result.userAgent.length > 300
      || /[\r\n\x00-\x1f\x7f]/.test(result.userAgent) || !Array.isArray(result.cookies)
      || result.cookies.length < 1 || result.cookies.length > 4
      || !result.cookies.some(cookie => cookie.name === 'cf_clearance')
      || result.cookies.some(cookie => !COOKIE_NAMES.has(cookie?.name)
        || typeof cookie.value !== 'string' || !COOKIE_VALUE.test(cookie.value)
        || typeof cookie.domain !== 'string'
        || !['huntedcow.com', '.huntedcow.com', 'account.huntedcow.com'].includes(cookie.domain)
      || typeof cookie.path !== 'string' || !cookie.path.startsWith('/') || cookie.path.length > 100
        || /[;\r\n\x00-\x1f\x7f]/.test(cookie.path)
        || typeof cookie.secure !== 'boolean')) {
    throw new SsoClearanceError('HuntedCow browser returned invalid credentials.');
  }
  return result;
}
