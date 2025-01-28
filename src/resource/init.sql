create table user
(
    id         INTEGER                             not null constraint user_pk primary key autoincrement,
    name       TEXT                                not null,
    token      text                                not null,
    created_at TIMESTAMP default CURRENT_TIMESTAMP not null,
    updated_at TIMESTAMP default CURRENT_TIMESTAMP not null
);

create unique index token_index
    on user (token);

