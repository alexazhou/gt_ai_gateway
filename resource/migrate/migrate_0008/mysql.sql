-- Add index for record created_at to speed up time-range queries
-- 注意：MySQL 的 CREATE INDEX 不支持 IF NOT EXISTS（迁移按 _migrations 追踪，只会执行一次）
CREATE INDEX idx_record_created_at ON record (created_at);
