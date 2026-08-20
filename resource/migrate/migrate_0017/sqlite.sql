create table config
(
    id         INTEGER                             not null constraint config_pk primary key autoincrement,
    name       TEXT                                not null,
    value      TEXT                                not null,
    created_at TIMESTAMP default CURRENT_TIMESTAMP not null,
    updated_at TIMESTAMP default CURRENT_TIMESTAMP not null
);

create unique index config_name_index
    on config (name);

insert into config (name, value)
values ('cch_rewrite_enabled', 'false');
