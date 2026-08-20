-- MySQL 8.0.13+ 允许 TEXT/BLOB 使用括号表达式默认值，与 SQLite DEFAULT '{}' 语义一致
ALTER TABLE vendor ADD COLUMN config LONGTEXT NOT NULL DEFAULT ('{}');
