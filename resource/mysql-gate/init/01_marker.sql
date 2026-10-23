-- T7 本地 MySQL 门：实例身份标记（marker）
--
-- 为什么需要它：`SELECT version()` 成功只能证明「连到的是 MySQL」，
-- **证明不了「连到的是我们起的那个容器」**。若本机另有 MySQL 占着 3306、
-- 或容器起失败但留着旧的端口转发，两条心跳照样全绿 —— 而门是假的。
-- 这个 marker 表由 compose 的 init 脚本在**首次初始化数据目录**时创建，
-- 只存在于「本次容器自己的数据卷」里，因此它是实例同一性的证据。
CREATE TABLE IF NOT EXISTS _t7_gate_marker (
    id TINYINT PRIMARY KEY,
    marker VARCHAR(64) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO _t7_gate_marker (id, marker)
VALUES (1, 't7-local-mysql-gate')
ON DUPLICATE KEY UPDATE marker = VALUES(marker);
