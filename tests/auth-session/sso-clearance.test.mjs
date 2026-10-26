import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renewSsoClearance, SsoClearanceError } from '../../ssoClearance.mjs';

const credentials = { userAgent: 'Chromium fixture', cookies: [
  { name: 'cf_clearance', value: 'clearance.fixture', domain: '.huntedcow.com', path: '/', secure: true },
  { name: 'hcs_session_key', value: 'session-fixture', domain: 'huntedcow.com', path: '/', secure: true },
] };

test('SSO clearance uses the Guide Chromium environment and validates returned cookies', async () => {
  const actual = await renewSsoClearance({ execFileFn: async (command, args, options) => {
    assert.equal(command, 'xvfb-run');
    assert.ok(args.includes('/app/scripts/control-plane/renew-sso-clearance.py'));
    assert.ok(args.includes('https://huntedcow.com/auth?game=6'));
    assert.equal(options.timeout, 100_000);
    return { stdout: JSON.stringify(credentials) };
  } });
  assert.deepEqual(actual, credentials);
});

test('SSO clearance rejects malformed and non-HuntedCow credentials without leaking subprocess output', async () => {
  await assert.rejects(renewSsoClearance({ entryUrl: 'https://elsewhere.example/auth', execFileFn: async () => {
    throw new Error('should not run');
  } }), SsoClearanceError);
  await assert.rejects(renewSsoClearance({ execFileFn: async () => ({ stdout: JSON.stringify({
    ...credentials, cookies: [{ ...credentials.cookies[0], domain: 'elsewhere.example' }],
  }) }) }), SsoClearanceError);
  await assert.rejects(renewSsoClearance({ execFileFn: async () => {
    throw new Error('private-cookie-value');
  } }), error => error instanceof SsoClearanceError && !error.message.includes('private-cookie-value'));
});
