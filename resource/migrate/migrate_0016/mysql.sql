-- MySQL 8.0.13+ 允许 TEXT/BLOB 使用括号表达式默认值（如 ('{}')）。
-- 用 DEFAULT ('{}') 与 SQLite 的 DEFAULT '{}' 语义一致。
ALTER TABLE model ADD COLUMN prices LONGTEXT NOT NULL DEFAULT ('{}');

UPDATE model
SET prices = JSON_OBJECT(
    'input', input_price,
    'output', output_price,
    'cache_read', 0
);

ALTER TABLE model DROP COLUMN input_price;
ALTER TABLE model DROP COLUMN output_price;
