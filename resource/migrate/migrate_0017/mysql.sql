create table config
(
    id         BIGINT                              not null auto_increment primary key,
    name       VARCHAR(255)                        not null,
    value      LONGTEXT                            not null,
    created_at TIMESTAMP default CURRENT_TIMESTAMP not null,
    updated_at TIMESTAMP default CURRENT_TIMESTAMP not null
) engine=InnoDB default charset=utf8mb4;

create unique index config_name_index
    on config (name);

insert into config (name, value)
values ('cch_rewrite_enabled', 'false');
