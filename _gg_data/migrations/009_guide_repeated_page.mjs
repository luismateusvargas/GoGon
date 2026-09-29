// The guide repeats its final index page instead of returning an empty page. Persist the last page's
// IDs so a sweep can recognize that boundary even when it falls between two work leases.
export async function up(client) {
    try {
        await client.query('ALTER TABLE catalog_guide_state ADD COLUMN sweep_prev_page_ids TEXT NULL CHECK (sweep_prev_page_ids IS NULL OR JSON_VALID(sweep_prev_page_ids))');
    } catch (error) {
        if (error?.code !== 'ER_DUP_FIELDNAME') throw error;
    }
}
