-- Migrate existing request_data / response_data from the record table into storage_record.
--
-- Each record becomes a single object stored under key "record/{id}":
--   { "request": <raw request_data string>, "response": <raw response_data string> }
--
-- request_data / response_data are kept as raw strings (not parsed) inside the combined
-- object, so the storage faithfully preserves whatever the gateway saw — including non-JSON
-- upstream error bodies (e.g. "Internal Server Error") and plain-text payloads. This matches
-- the existing record.request_data / record.response_data semantics: the frontend reads a
-- string and JSON.parses it itself. json_object() takes care of JSON-escaping the strings.
--
-- Rows where both columns are NULL are skipped. The combined JSON text is CAST to BLOB so it
-- is stored as UTF-8 bytes, matching how objectStorageService.putText persists text
-- (TextEncoder.encode -> Buffer). length(CAST(... AS BLOB)) gives the byte length for size_bytes.
--
-- ON CONFLICT DO NOTHING keeps the migration idempotent in case it is re-applied.
-- The record columns are intentionally left in place here; they are dropped in a later
-- migration once reads/writes have been switched over to objectStorageService.

INSERT INTO storage_record (object_key, size_bytes, created_at, updated_at, data)
SELECT
    'record/' || id,
    length(CAST(json_object('request', request_data, 'response', response_data) AS BLOB)),
    created_at,
    updated_at,
    CAST(json_object('request', request_data, 'response', response_data) AS BLOB)
FROM record
WHERE request_data IS NOT NULL OR response_data IS NOT NULL
ON CONFLICT(object_key) DO NOTHING;
