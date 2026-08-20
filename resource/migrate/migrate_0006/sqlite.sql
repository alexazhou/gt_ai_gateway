-- Migration to update vendor table: replace url and api_format with urls JSON column

-- Step 1: Create new vendor table with urls column
CREATE TABLE vendor_new
(
    id         INTEGER                             not null constraint vendor_new_pk primary key autoincrement,
    type       text                                not null,
    name       TEXT                                not null,
    token      TEXT                                not null,
    urls       TEXT                                default '{}' not null,

    created_at TIMESTAMP default CURRENT_TIMESTAMP not null,
    updated_at TIMESTAMP default CURRENT_TIMESTAMP not null
);

-- Step 2: Copy data from old table to new table
-- Convert existing url and api_format to urls JSON format
INSERT INTO vendor_new (id, type, name, token, urls, created_at, updated_at)
SELECT id, type, name, token, json_object('openai', url), created_at, updated_at
FROM vendor;

-- Step 3: Drop old table
DROP TABLE vendor;

-- Step 4: Rename new table to vendor
ALTER TABLE vendor_new RENAME TO vendor;

-- Add statistics fields to record table
ALTER TABLE record ADD COLUMN prompt_tokens INTEGER null;
ALTER TABLE record ADD COLUMN output_tokens INTEGER null;
ALTER TABLE record ADD COLUMN first_token_latency INTEGER null;
ALTER TABLE record ADD COLUMN start_at TIMESTAMP null;
ALTER TABLE record ADD COLUMN end_at TIMESTAMP null;