-- Migrate existing request_data / response_data from the record table into storage_record.
--
-- Each record becomes a single object stored under key "record/{id}":
--   { "request": <raw request_data string>, "response": <raw response_data string> }
--
-- request_data / response_data are kept as raw strings (not parsed) inside the combined
-- object, so the storage faithfully preserves whatever the gateway saw. This mirrors the
-- SQLite version; differences below are purely SQL dialect:
--   - 'record/' || id            -> CONCAT('record/', id)
--   - json_object(...)           -> JSON_OBJECT(...)
--   - CAST(... AS BLOB)          -> CAST(... AS BINARY)
--   - length(... AS BLOB)        -> OCTET_LENGTH(... AS BINARY)
--   - ON CONFLICT DO NOTHING     -> ON DUPLICATE KEY UPDATE object_key = object_key (no-op)

INSERT INTO storage_record (object_key, size_bytes, created_at, updated_at, data)
SELECT
    CONCAT('record/', id),
    OCTET_LENGTH(CAST(JSON_OBJECT('request', request_data, 'response', response_data) AS BINARY)),
    created_at,
    updated_at,
    CAST(JSON_OBJECT('request', request_data, 'response', response_data) AS BINARY)
FROM record
WHERE request_data IS NOT NULL OR response_data IS NOT NULL
ON DUPLICATE KEY UPDATE object_key = object_key;
