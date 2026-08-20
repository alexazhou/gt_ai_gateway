CREATE TABLE IF NOT EXISTS vendor_model (
    id         BIGINT   NOT NULL AUTO_INCREMENT PRIMARY KEY,
    vendor_id  BIGINT   NOT NULL,
    model_id   VARCHAR(255) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(vendor_id, model_id)
) engine=InnoDB default charset=utf8mb4;
CREATE INDEX idx_vendor_model_vendor_id ON vendor_model (vendor_id);
