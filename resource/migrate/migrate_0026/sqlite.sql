-- 模型多上游路由：新增路由模式/配置列，将存量 vendor_id / vendor_model_id 包装成单个上游，再删除顶层字段
-- 两列缺省均为 NULL，不依赖 DB 默认值，实际值由应用代码在保存时写入
ALTER TABLE model ADD COLUMN routing_mode TEXT DEFAULT NULL;
ALTER TABLE model ADD COLUMN routing_config TEXT DEFAULT NULL;

UPDATE model SET
    routing_mode = 'single',
    routing_config = json_object(
        'upstreams',
        json_array(json_object(
            'vendor_id', vendor_id,
            'vendor_model_id', vendor_model_id,
            'enabled', json('true')
        )),
        'failover',
        json_object('enabled', json('true'))
    )
WHERE vendor_id IS NOT NULL;

ALTER TABLE model DROP COLUMN vendor_id;
ALTER TABLE model DROP COLUMN vendor_model_id;
