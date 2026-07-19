# SgModel 多上游路由设计

## 1. 目标

一个 SgModel 可以配置一个或多个上游：

| 模式 | 规则 |
|------|------|
| `single` | 使用唯一启用的上游 |
| `load_balance` | 从可用上游中等概率随机选择 |
| `failover` | 按配置顺序选择第一个可用上游 |

三种模式都至少需要一个启用上游。数据直接保存在现有表中，不新增映射表、健康表或尝试记录表。

## 2. 数据结构

`model` 新增：

- `routing_mode TEXT NOT NULL DEFAULT 'single'`
- `routing_config TEXT NOT NULL DEFAULT '{"upstreams":[]}'`

`vendor_model` 新增：

- `health TEXT NOT NULL DEFAULT '{}'`

核心类型：

```typescript
class ModelUpstreamConfig {
    vendor_id: number;
    vendor_model_id?: number;
    enabled: boolean;
}

class ModelRoutingConfig extends CastsAttributes {
    upstreams: ModelUpstreamConfig[];
}

class VendorModelProtocolHealth {
    last_failure_at: string | null;
}

class VendorModelHealth extends CastsAttributes {
    // 按 ApiFormat 保存 VendorModelProtocolHealth
}
```

`routing_config` 和 `health` 使用自定义 cast，数据库保存 JSON，模型属性保持为对应的类实例。

示例：

```json
{
    "upstreams": [
        {
            "vendor_id": 3,
            "vendor_model_id": 101,
            "enabled": true
        },
        {
            "vendor_id": 8,
            "enabled": true
        }
    ]
}
```

```json
{
    "openai": {
        "last_failure_at": "2026-07-19T11:59:30.000Z"
    }
}
```

health 保留协议对象层级，便于以后增加其他状态字段。

## 3. 配置规则

- `vendor_id` 必填且必须存在。
- `vendor_model_id` 可选；提供时必须存在并属于对应 vendor。
- 未提供 `vendor_model_id` 时，按 `vendor_id + SgModel.name` 查找 vendor model。
- `single` 自动模式找不到 vendor model 时，路由服务创建同名 vendor model。
- `load_balance` 和 `failover` 的自动模式必须在保存配置时匹配到 vendor model。
- 至少有一个启用上游；`single` 只能有一个启用上游。
- 同一个实际上游不能重复配置。
- `enabled` 缺省为 `true`。

旧的 `vendor_id/vendor_model_id` 请求转换为 `single` 配置。保存新配置时，仍将第一个启用上游同步到旧字段，兼容现有接口和前端。

## 4. 路由服务

`modelRoutingService.selectUpstream(model, format)`：

1. 解析启用的上游并确定实际 vendor model 和协议。
2. 根据 `vendor_model.health` 排除冷却中的候选。
3. 调用 `routing_mode` 对应的策略类。
4. 返回只包含 `vendorModelId` 的 `ModelRoutingResult`。

策略接口：

```typescript
abstract class BaseRoutingStrategy {
    abstract selectUpstream(
        model: SgModel,
        vendorModels: SgVendorModel[],
    ): SgVendorModel | null;
}
```

路由服务先按每个上游的协议健康状态过滤模型。策略只选择模型，不读取数据库、不发送请求、不写健康状态。

## 5. 请求与失败切换

`senderService.sendRequest` 负责重试编排：

1. 调用路由服务选择目标。
2. 查询 vendor model 和 vendor。
3. 调用 `sendRequestToUpstream` 执行一次请求。
4. 遇到可重试失败时记录 health，再回到步骤 1。
5. 没有可用目标时返回 503。

`sendRequestToUpstream` 保留原发送流程，只增加路由返回的 vendor model ID 参数。它仍负责创建和更新本次尝试的 record。

可重试 HTTP 状态码：`401、403、408、429、500、502、503、504`。网络请求失败也会切换；客户端主动断开不切换。收到成功的流式响应后不再切换。

每次可重试失败写入：

```typescript
health[upstreamFormat].last_failure_at = now.toISOString();
```

冷却时间由 `UPSTREAM_FAILURE_COOLDOWN_MS` 控制。冷却到期后自动恢复；成功请求不修改 health。

每次上游尝试创建一条 record，只有成功响应产生 usage 和费用。

## 6. API 与迁移

创建和更新接口接受：

```json
{
    "name": "claude-sonnet",
    "routing_mode": "failover",
    "routing_config": {
        "upstreams": [
            {
                "vendor_id": 3,
                "vendor_model_id": 101,
                "enabled": true
            },
            {
                "vendor_id": 8,
                "enabled": true
            }
        ]
    }
}
```

迁移将每个已有 model 的 `vendor_id/vendor_model_id` 包装成一个 `single` 上游。旧字段暂时保留，避免同时修改现有前端和其他接口。

## 7. 验收重点

- 三种策略选择规则正确，且都支持只有一个启用上游。
- 自动和显式 vendor model 解析正确。
- 不同上游使用各自的 URL、Token、模型名和协议。
- 可重试失败会更新对应协议的 health 并重新路由。
- failover 按数组顺序切换，load balance 等概率选择。
- 每次尝试保存一条 record。
- Node 和 Worker 模式行为一致。
