import { getSetting } from '../config/runtime.mjs';
import { GUIDE_POLICY } from './contracts/policy.js';

/** Returns the current Guide schedule; invalid bootstrap values fall back to the daily default.
 * @returns {typeof GUIDE_POLICY} Effective policy for the next scheduling decision.
 */
export function getGuidePolicy() {
    const value = getSetting('GG_GUIDE_SCAN_INTERVAL_HOURS');
    const hours = /^\d{1,3}$/.test(value) ? Number(value) : NaN;
    const interval = hours >= 1 && hours <= 720 ? hours * 3600_000 : GUIDE_POLICY.checkIntervalMs;
    return { ...GUIDE_POLICY, checkIntervalMs: interval, detailRefreshAfterMs: interval };
}
