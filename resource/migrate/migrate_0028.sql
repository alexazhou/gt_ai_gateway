-- user.balance 改为整数微元存储（1 元 = 1000000 微元，粒度 0.000001 元）
-- 避免 SQLite 浮点存储带来的噪声与科学计数法显示
ALTER TABLE user ADD COLUMN balance_units INTEGER DEFAULT 0 NOT NULL;
UPDATE user SET balance_units = ROUND(balance / 0.000001);
ALTER TABLE user DROP COLUMN balance;
ALTER TABLE user RENAME COLUMN balance_units TO balance;
