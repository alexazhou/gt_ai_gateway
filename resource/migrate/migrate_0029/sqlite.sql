-- record.cost / recharge_records.amount 从"元"(DECIMAL) 改为整数微元（1 元 = 1,000,000 微元）。
-- 与 user.balance 的 balance_units 做法一致：两库统一存储整数微元，避免 DECIMAL 浮点/字符串问题。

ALTER TABLE record ADD COLUMN cost_units INTEGER NOT NULL DEFAULT 0;
UPDATE record SET cost_units = ROUND(cost * 1000000);
ALTER TABLE record DROP COLUMN cost;
ALTER TABLE record RENAME COLUMN cost_units TO cost;

ALTER TABLE recharge_records ADD COLUMN amount_units INTEGER NOT NULL DEFAULT 0;
UPDATE recharge_records SET amount_units = ROUND(amount * 1000000);
ALTER TABLE recharge_records DROP COLUMN amount;
ALTER TABLE recharge_records RENAME COLUMN amount_units TO amount;
