ALTER TABLE model ADD COLUMN enable BOOLEAN DEFAULT true NOT NULL;
DROP INDEX IF EXISTS name_index;
CREATE UNIQUE INDEX enabled_model_name_index ON model(name) WHERE enable = 1;