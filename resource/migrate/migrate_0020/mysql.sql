CREATE TABLE client_config
(
    id            BIGINT                              not null auto_increment primary key,
    client        VARCHAR(255)                        not null,
    name          VARCHAR(255)                        not null,
    configContent LONGTEXT                            not null,
    enabled       TINYINT(1)  default 0               not null,
    -- MySQL 不支持 SQLite 的部分索引（WHERE enabled=1）。
    -- 用生成列模拟「每个 client 仅允许一个启用配置」的唯一约束：
    -- 当 enabled=1 时取 client 值，否则为 NULL（NULL 不参与唯一性）。
    enabled_client VARCHAR(255) GENERATED ALWAYS AS (IF(enabled = 1, client, NULL)) STORED,
    created_at    TIMESTAMP default CURRENT_TIMESTAMP not null,
    updated_at    TIMESTAMP default CURRENT_TIMESTAMP not null
) engine=InnoDB default charset=utf8mb4;

CREATE INDEX client_config_client_index
    ON client_config (client);

CREATE UNIQUE INDEX client_config_enabled_client_unique
    ON client_config (enabled_client);
