-- Migration to add billing management fields

-- Add balance field to user table
ALTER TABLE user ADD COLUMN balance DECIMAL(10, 2) DEFAULT 0.0 NOT NULL;

-- Add pricing fields to model table
ALTER TABLE model ADD COLUMN input_price DECIMAL(10, 6) DEFAULT 0.0 NOT NULL;
ALTER TABLE model ADD COLUMN output_price DECIMAL(10, 6) DEFAULT 0.0 NOT NULL;

-- Create recharge_records table
CREATE TABLE recharge_records
(
    id         INTEGER                             not null constraint recharge_records_pk primary key autoincrement,
    user_id    INTEGER                             not null,
    amount     DECIMAL(10, 2)                      not null,
    type       TEXT                                not null, -- 'recharge' or 'adjustment'
    remark     TEXT                                null,
    operator   TEXT                                null,

    created_at TIMESTAMP default CURRENT_TIMESTAMP not null,
    updated_at TIMESTAMP default CURRENT_TIMESTAMP not null,

    constraint recharge_records_user_fk foreign key (user_id) references user (id) on delete cascade
);

-- Add cost field to record table
ALTER TABLE record ADD COLUMN cost DECIMAL(10, 6) DEFAULT 0.0 NOT NULL;