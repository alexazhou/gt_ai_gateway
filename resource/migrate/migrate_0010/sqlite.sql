ALTER TABLE model ADD COLUMN vendor_model_id INTEGER NULL REFERENCES vendor_model(id);
