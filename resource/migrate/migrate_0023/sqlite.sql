CREATE TABLE storage_record
(
    object_key TEXT                                not null constraint storage_record_pk primary key,
    size_bytes INTEGER  default 0                 not null,
    created_at TIMESTAMP default CURRENT_TIMESTAMP not null,
    updated_at TIMESTAMP default CURRENT_TIMESTAMP not null,
    data       BLOB                                not null
);
