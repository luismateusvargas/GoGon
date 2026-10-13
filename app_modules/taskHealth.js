// app_modules/taskHealth.js - monitor overdue rule (specs/tasks/2026-10-notification-progress-health.md, AC-3)
// A module is overdue when its next run should have started and has not, beyond a grace period:
//   expected start = nextRunAt (set when the engine schedules the next run), or, without it, the end of
//                    lastRun plus the interval
//   grace          = max(interval, TASK_OVERDUE_MIN_GRACE): one missed cycle, and at least two minutes
//                    for timer and event-loop delay on the short-interval monitors
// Never overdue: a disabled or stopped module, a paused engine (account switch), a run in flight, and a
// module that has not finished its first run yet.

export const TASK_OVERDUE_MIN_GRACE = 2 * 60_000;

/** Grace period in ms for a module with this interval. */
export function overdueGrace(intervalMs) {
    return Math.max(Number(intervalMs) || 0, TASK_OVERDUE_MIN_GRACE);
}

/**
 * How late a module's next run is beyond the grace period.
 * @param {{ enabled: boolean, isActive: boolean, isRunning: boolean, interval: number, nextRunAt?: number|null,
 *           lastRun: { startedAt: number, durationMs: number }|null }} task - one getTasksStatus() entry
 * @param {{ now?: number, paused?: boolean }} [opts]
 * @returns {number} ms overdue; 0 when not overdue
 */
export function overdueBy(task, { now = Date.now(), paused = false } = {}) {
    if (paused || !task.enabled || !task.isActive || task.isRunning || !task.lastRun) return 0;
    const expected = Number.isFinite(task.nextRunAt)
        ? task.nextRunAt
        : task.lastRun.startedAt + (task.lastRun.durationMs || 0) + task.interval;
    return Math.max(0, now - expected - overdueGrace(task.interval));
}
