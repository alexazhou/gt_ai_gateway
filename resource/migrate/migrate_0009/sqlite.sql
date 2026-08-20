CREATE TABLE IF NOT EXISTS vendor_model (
    id         INTEGER   NOT NULL PRIMARY KEY AUTOINCREMENT,
    vendor_id  INTEGER   NOT NULL,
    model_id   TEXT      NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(vendor_id, model_id)
);
CREATE INDEX IF NOT EXISTS idx_vendor_model_vendor_id ON vendor_model (vendor_id);
