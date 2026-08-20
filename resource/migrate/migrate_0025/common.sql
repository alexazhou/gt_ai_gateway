-- request/response payloads now live in object storage (see migrate_0023 / migrate_0024
-- and objectStorageService). Drop the legacy columns from the record table.
-- The request_data / response_data fields remain as virtual fields on SgRecord,
-- populated by recordService.attachPayload from object storage when reading a record.

ALTER TABLE record DROP COLUMN request_data;
ALTER TABLE record DROP COLUMN response_data;
