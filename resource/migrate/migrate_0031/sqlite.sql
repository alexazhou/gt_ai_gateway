-- rule：请求规则表（限流 / 访问控制），scope / config 用 JSON 列以最大化扩展性
-- worker（D1）复用 sqlite 方言
create table rule
(
    id         INTEGER                             not null constraint rule_pk primary key autoincrement,
    type       TEXT                                not null,
    name       TEXT                                not null default '',
    scope      TEXT                                not null,
    config     TEXT                                not null,
    enabled    INTEGER                             not null default 1,
    created_at TIMESTAMP default CURRENT_TIMESTAMP not null,
    updated_at TIMESTAMP default CURRENT_TIMESTAMP not null
);
