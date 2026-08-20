
create table record
(
    id         INTEGER                             not null constraint user_pk primary key autoincrement,
    user_id    INTEGER                             not null,
    model_id   INTEGER                             not null,
    request_data       TEXT                        null,
    response_data      TEXT                        null,
    status             TEXT                        not null,

    created_at TIMESTAMP default CURRENT_TIMESTAMP not null,
    updated_at TIMESTAMP default CURRENT_TIMESTAMP not null
);
