-- CAT-TASK-014 / DEC-CAT-023: guide discovery runs once a week and each run reads every detail.
-- Details never read (including snapshot IDs spread across 30 days by CAT-TASK-012) become due now.
-- Read details keep their schedule; the next weekly sweep makes them due again.
UPDATE catalog_guide_ids SET next_detail_at = '1970-01-01T00:00:00.000Z'
WHERE detail_checked_at IS NULL;
