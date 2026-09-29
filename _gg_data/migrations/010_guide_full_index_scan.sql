-- CAT-TASK-013: an old incremental sweep may omit pages containing newly released IDs.
-- Rebuild discovery cursors once for complete daily coverage. Collected IDs, details,
-- catalog observations, projections, and request counters are preserved.
UPDATE catalog_guide_leases SET completed_at = issued_at
WHERE completed_at IS NULL;

UPDATE catalog_guide_state SET last_successful_check_at = NULL, last_full_sweep_at = NULL,
    last_page_seen = NULL, sweep_mode = NULL, sweep_started_at = NULL, next_page = 0,
    sweep_pages_checked = 0, sweep_max_id = 0, sweep_prev_min_id = NULL,
    sweep_prev_page_ids = NULL, stop_after_page = NULL, order_state = 'attested',
    status = 'idle', status_reason = NULL
WHERE entity_kind IN ('item', 'creature', 'realm', 'master_realm');
