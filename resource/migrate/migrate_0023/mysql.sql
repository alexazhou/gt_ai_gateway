CREATE TABLE storage_record
(
    object_key VARCHAR(191)                          not null primary key,
    size_bytes BIGINT      default 0                 not null,
    created_at TIMESTAMP default CURRENT_TIMESTAMP not null,
    updated_at TIMESTAMP default CURRENT_TIMESTAMP not null,
    data       LONGBLOB                              not null
) engine=InnoDB default charset=utf8mb4;
