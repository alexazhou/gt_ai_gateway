ALTER TABLE model ADD COLUMN prices TEXT DEFAULT '{}' NOT NULL;

UPDATE model 
SET prices = json_object(
    'input', input_price, 
    'output', output_price, 
    'cache_read', 0
);

ALTER TABLE model DROP COLUMN input_price;
ALTER TABLE model DROP COLUMN output_price;
