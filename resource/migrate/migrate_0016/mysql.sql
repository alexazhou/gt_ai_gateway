ALTER TABLE model ADD COLUMN prices LONGTEXT DEFAULT '{}' NOT NULL;

UPDATE model
SET prices = JSON_OBJECT(
    'input', input_price,
    'output', output_price,
    'cache_read', 0
);

ALTER TABLE model DROP COLUMN input_price;
ALTER TABLE model DROP COLUMN output_price;
