
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


create table model
(
    id         INTEGER                             not null constraint user_pk primary key autoincrement,
    name       TEXT                                not null,
    vendor_id  INTEGER                             not null,

    created_at TIMESTAMP default CURRENT_TIMESTAMP not null,
    updated_at TIMESTAMP default CURRENT_TIMESTAMP not null
);

create unique index name_index
    on model (name);



create table vendor
(
    id         INTEGER                             not null constraint user_pk primary key autoincrement,
    type       text                                not null,
    name       TEXT                                not null,
    token      TEXT                                not null,
    url        text                                default null,

    created_at TIMESTAMP default CURRENT_TIMESTAMP not null,
    updated_at TIMESTAMP default CURRENT_TIMESTAMP not null
);





