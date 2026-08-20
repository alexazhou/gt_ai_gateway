-- Allow failed request records to be created before a gateway model is resolved.
-- Replace the original NOT NULL model_id column with a nullable column.
ALTER TABLE record ADD COLUMN model_id_nullable INTEGER NULL;
UPDATE record SET model_id_nullable = model_id;
ALTER TABLE record DROP COLUMN model_id;
ALTER TABLE record RENAME COLUMN model_id_nullable TO model_id;
