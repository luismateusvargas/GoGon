import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuideClearanceError, renewGuideClearance } from '../../catalog/guideClearance.js';

test('guide clearance helper returns bounded credentials without passing secrets in arguments', async () => {
    const result = await renewGuideClearance({ execFileFn: async (command, args, options) => {
        assert.equal(command, 'xvfb-run');
        assert.ok(args.includes('/app/scripts/control-plane/renew-guide-clearance.py'));
        assert.equal(options.maxBuffer, 16 * 1024);
        return { stdout: JSON.stringify({ clearance: 'valid.clearance-1', userAgent: 'Chrome guide test' }) };
    } });
    assert.deepEqual(result, { clearance: 'valid.clearance-1', userAgent: 'Chrome guide test' });
});

test('guide clearance helper rejects malformed output and hides subprocess errors', async () => {
    await assert.rejects(renewGuideClearance({ execFileFn: async () => ({ stdout: '{' }) }), GuideClearanceError);
    await assert.rejects(renewGuideClearance({ execFileFn: async () => ({ stdout: JSON.stringify({
        clearance: 'bad\r\ncookie', userAgent: 'Chrome guide test',
    }) }) }), GuideClearanceError);
    await assert.rejects(renewGuideClearance({ execFileFn: async () => {
        throw new Error('private-cookie-value');
    } }), error => error instanceof GuideClearanceError && !error.message.includes('private-cookie-value'));
});
