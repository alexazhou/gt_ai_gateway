-- Migration to add billing management fields

-- Add balance field to user table
ALTER TABLE user ADD COLUMN balance DECIMAL(10, 2) DEFAULT 0.0 NOT NULL;

-- Add pricing fields to model table
ALTER TABLE model ADD COLUMN input_price DECIMAL(10, 6) DEFAULT 0.0 NOT NULL;
ALTER TABLE model ADD COLUMN output_price DECIMAL(10, 6) DEFAULT 0.0 NOT NULL;

-- Create recharge_records table
CREATE TABLE recharge_records
(
    id         BIGINT                              not null auto_increment primary key,
    user_id    BIGINT                              not null,
    amount     DECIMAL(10, 2)                      not null,
    type       VARCHAR(16)                         not null, -- 'recharge' or 'adjustment'
    remark     LONGTEXT                            null,
    operator   LONGTEXT                            null,
    created_at TIMESTAMP default CURRENT_TIMESTAMP not null,
    updated_at TIMESTAMP default CURRENT_TIMESTAMP not null,
    constraint recharge_records_user_fk foreign key (user_id) references user (id) on delete cascade
) engine=InnoDB default charset=utf8mb4;

-- Add cost field to record table
ALTER TABLE record ADD COLUMN cost DECIMAL(10, 6) DEFAULT 0.0 NOT NULL;
