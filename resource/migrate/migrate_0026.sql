ALTER TABLE model ADD COLUMN routing_mode TEXT NOT NULL DEFAULT 'single';
ALTER TABLE model ADD COLUMN routing_config TEXT NOT NULL DEFAULT '{"upstreams":[]}';
ALTER TABLE vendor_model ADD COLUMN health TEXT NOT NULL DEFAULT '{}';

UPDATE model SET routing_config = json_object(
    'upstreams',
    json_array(json_object(
        'vendor_id', vendor_id,
        'vendor_model_id', vendor_model_id,
        'enabled', json('true')
    ))
) WHERE vendor_id IS NOT NULL;
