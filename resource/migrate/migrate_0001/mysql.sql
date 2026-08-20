
create table user
(
    id         BIGINT                              not null auto_increment primary key,
    name       VARCHAR(255)                        not null,
    token      VARCHAR(255)                        not null,
    created_at TIMESTAMP default CURRENT_TIMESTAMP not null,
    updated_at TIMESTAMP default CURRENT_TIMESTAMP not null
) engine=InnoDB default charset=utf8mb4;

create unique index token_index
    on user (token);


create table model
(
    id         BIGINT                              not null auto_increment primary key,
    name       VARCHAR(255)                        not null,
    vendor_id  BIGINT                              not null,
    created_at TIMESTAMP default CURRENT_TIMESTAMP not null,
    updated_at TIMESTAMP default CURRENT_TIMESTAMP not null
) engine=InnoDB default charset=utf8mb4;

create unique index name_index
    on model (name);


create table vendor
(
    id         BIGINT                              not null auto_increment primary key,
    type       VARCHAR(64)                         not null,
    name       VARCHAR(255)                        not null,
    token      LONGTEXT                            not null,
    url        LONGTEXT                            default null,
    created_at TIMESTAMP default CURRENT_TIMESTAMP not null,
    updated_at TIMESTAMP default CURRENT_TIMESTAMP not null
) engine=InnoDB default charset=utf8mb4;
