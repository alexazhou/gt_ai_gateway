-- Add index for record created_at to speed up time-range queries
CREATE INDEX IF NOT EXISTS idx_record_created_at ON record (created_at);
