-- Missing Guide detail + missing required fields + unresolved drops is 65 characters.
-- Preserve every reason rather than truncating the diagnostic or rejecting a valid projection.
ALTER TABLE catalog_entities MODIFY COLUMN incomplete_reason VARCHAR(128);
