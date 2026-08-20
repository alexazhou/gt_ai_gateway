-- MySQL 的 ADD COLUMN 不支持内联 REFERENCES 外键子句（会被忽略）。
-- 这里仅增加列，外键约束如需建立请另立约束。
ALTER TABLE model ADD COLUMN vendor_model_id BIGINT NULL;
