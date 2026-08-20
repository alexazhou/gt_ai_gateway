
create table record
(
    id                BIGINT                              not null auto_increment primary key,
    user_id           BIGINT                              not null,
    model_id          BIGINT                              not null,
    request_data      LONGTEXT                            null,
    response_data     LONGTEXT                            null,
    status            VARCHAR(32)                         not null,
    created_at        TIMESTAMP default CURRENT_TIMESTAMP not null,
    updated_at        TIMESTAMP default CURRENT_TIMESTAMP not null
) engine=InnoDB default charset=utf8mb4;
