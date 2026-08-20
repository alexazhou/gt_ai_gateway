CREATE TABLE client_config
(
    id            INTEGER                             not null constraint client_config_pk primary key autoincrement,
    client        TEXT                                not null,
    name          TEXT                                not null,
    configContent TEXT                                not null,
    enabled       INTEGER   default 0                 not null,
    created_at    TIMESTAMP default CURRENT_TIMESTAMP not null,
    updated_at    TIMESTAMP default CURRENT_TIMESTAMP not null
);

CREATE INDEX client_config_client_index
    ON client_config (client);

CREATE UNIQUE INDEX client_config_enabled_client_unique
    ON client_config (client)
    WHERE enabled = 1;
