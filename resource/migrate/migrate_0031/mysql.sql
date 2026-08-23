-- rule：请求规则表（限流 / 访问控制），scope / config 用 JSON 列以最大化扩展性
create table `rule`
(
    id         BIGINT                              not null auto_increment primary key,
    type       VARCHAR(32)                         not null,
    name       VARCHAR(255)                        not null default '',
    scope      TEXT                                not null,
    config     TEXT                                not null,
    enabled    INTEGER                             not null default 1,
    created_at TIMESTAMP default CURRENT_TIMESTAMP not null,
    updated_at TIMESTAMP default CURRENT_TIMESTAMP not null
) engine=InnoDB default charset=utf8mb4;
