create table user
(
    id                                             not null,
    name       TEXT                                not null,
    token      text                                not null,
    created_at TIMESTAMP default CURRENT_TIMESTAMP not null,
    updated_at TIMESTAMP default CURRENT_TIMESTAMP not null
);

create unique index token_index
    on user (token);

create unique index user_id_uindex
    on user (id);