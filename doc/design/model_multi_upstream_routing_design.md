# SgModel 多上游路由设计

## 1. 背景

网关对接多个上游模型厂商（如 OpenAI、Anthropic、智谱等）。一个对外暴露的模型名（SgModel）可能对应多个上游：官方渠道、代理商、备用渠道等。

于是网关必须回答两个问题：

1. **一个请求该发给哪个上游？** 多个上游都可用时，怎么选？
2. **选中的上游失败时怎么办？** 直接返回失败，还是换一个上游重试？

这两个问题在传统软件里分别对应「负载均衡」和「故障转移」。但这两个词很容易混淆——负载均衡系统本身也常具备绕过故障节点的能力（nginx、HAProxy、LiteLLM 都会做健康检查与故障感知）。如果把「选谁」和「失败后怎么办」混进同一个概念，就会出现「load_balance 到底会不会故障转移」这类说不清的边界。

本设计的目标：**把「选择策略」和「失败处理」拆成两个正交的配置**，让每个问题有唯一、清晰的答案。

## 2. 实现思路

### 2.1 拆成两个正交概念

参考业界成熟方案——LiteLLM 把 `routing_strategy`（选择算法）与 `cooldown/retry`（失败处理）分开配置；one-api / new-api 用渠道的 `priority` / `weight` 属性表达路由——本设计把路由拆成两个独立维度：

- **`routing_mode`（选择策略）**：只回答「正常时在可用上游里选谁」。
- **`failover.enabled`（失败处理）**：只回答「可重试失败后，要不要换下一个上游」。

`routing_mode` 提供三种选择策略：

| 策略 | 选择规则 | 典型用途 |
|------|----------|----------|
| `single` | 使用唯一启用的上游 | 一对一映射 |
| `load_balance` | 从可用上游等概率随机 | 分摊流量 |
| `first_available` | 按配置顺序取第一个可用 | 主备 / 有序优先 |

### 2.2 失败处理统一，与策略无关

任何策略下失败处理都遵循同一套规则：可重试失败时**总是**把失败目标标记冷却（与 `failover.enabled` 无关，冷却对后续请求和其他模型生效），然后用**同一种策略**在剩余可用上游里重新选择；`failover.enabled = false` 则本次请求失败直接返回、不重试。

策略之间不再各自实现重试逻辑。「负载均衡会不会故障转移」被拆解为两个独立答案：**选谁**由 `routing_mode` 决定，**要不要切**由 `failover.enabled` 决定。

### 2.3 命名说明

第三种模式原命名为 `failover`。为避免与「失败后的切换动作」混淆（该动作由 `failover.enabled` 表达），改名为 `first_available`，专指「按顺序选择第一个可用」这个选择规则。此命名有业界先例（MySQL Router 的 `routing_strategy: first-available`）。

### 2.4 技术选型

- 不新增任何表；配置存于现有 `model` 表，上游健康状态只存于进程内存。
- `routing_config` 以 JSON 存储，通过 Sutando 自定义 cast 在数据库字符串与类实例之间转换。
- 健康状态按协议（`openai` / `anthropic` 等）分开记录，因为同一上游可能同时支持多种协议，失败是按具体协议发生和恢复的；不写入 `vendor_model` 表，进程重启即清空。

## 3. 字段取值

### 3.1 `routing_mode`（`model` 表，TEXT）

| 值 | 含义 | 约束 |
|----|------|------|
| `single` | 使用唯一启用的上游 | 恰好一个启用上游 |
| `load_balance` | 从可用上游等概率随机选择 | 至少一个启用上游 |
| `first_available` | 按配置顺序选择第一个可用上游 | 至少一个启用上游 |

缺省值：`single`。

### 3.2 `failover.enabled`（`model.routing_config` 内）

| 值 | 行为 |
|----|------|
| `true` | 可重试失败后，冷却失败目标，用同一种策略在剩余可用上游里重新选择 |
| `false` | 失败直接返回，不重试 |

缺省值：`true`。

与 `routing_mode` 组合后的行为矩阵：

| `routing_mode` | `failover.enabled = false` | `failover.enabled = true` |
|----------------|----------------------------|----------------------------|
| `single` | 失败直接返回 | 无其他上游可切，重试后因无可用目标返回 503 |
| `load_balance` | 随机选，失败直接返回 | 随机选 → 失败冷却 → 剩余可用里再随机 |
| `first_available` | 取第一个可用，失败直接返回 | 取第一个可用 → 失败冷却 → 下一个可用 |

### 3.3 `routing_config`（`model` 表，TEXT，JSON）

```json
{
    "upstreams": [
        { "vendor_id": 3, "vendor_model_id": 101, "enabled": true },
        { "vendor_id": 8, "enabled": true }
    ],
    "failover": {
        "enabled": true
    }
}
```

字段说明：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `upstreams` | 数组 | 是 | 上游列表 |
| `upstreams[].vendor_id` | number | 是 | 上游所属 vendor |
| `upstreams[].vendor_model_id` | number | 否 | 指定 vendor model；缺省按 `vendor_id + model.name` 解析 |
| `upstreams[].enabled` | boolean | 否（缺省 `true`） | 是否启用该上游 |
| `failover` | object | 否 | 失败处理配置 |
| `failover.enabled` | boolean | 否（缺省 `true`） | 失败后是否切换下一个可用上游 |

类型定义（Sutando 自定义 cast）：

```typescript
class ModelUpstreamConfig {
    vendor_id: number;
    vendor_model_id?: number;
    enabled: boolean;
}

class ModelFailoverConfig {
    enabled: boolean;
}

class ModelRoutingConfig extends CastsAttributes {
    upstreams: ModelUpstreamConfig[];
    failover: ModelFailoverConfig;
}
```

### 3.4 上游健康状态（进程内存，非持久化）

不存储在 `vendor_model` 表，保存在网关进程内存中：

```typescript
// key: `${vendor_id}:${vendor_model_name}:${api_format}`
// value: 最近一次失败时间（epoch ms）
interface UpstreamHealthEntry {
    last_failure_at: number;
}
```

key 中间段统一用 vendor model 名称：显式上游取 `vendor_model.model_id`，自动上游取 `SgModel.name`。同一物理上游（同一 vendor + 同一模型名）无论显式还是自动配置，key 一致，冷却共享；不同模型名指向同一 vendor 时不互相串扰。

- 冷却判断：`now - last_failure_at < UPSTREAM_FAILURE_COOLDOWN_MS`。
- 冷却状态按上游共享，不区分 model——A 模型冷却了某上游，其他模型选择时同样避开它。
- 可重试失败时写入 / 刷新对应 key；成功请求不修改。
- 进程重启即清空——冷却本就是短时机制，不持久化可避免「重启后上游仍处于冷却」。
- Worker 模式下各进程冷却表独立，冷却只对本进程生效（可接受的取舍；v2 如需全局一致可接共享存储）。
- 底层由通用 KV 缓存服务（`cacheService`）承载，key 加 `upstream-health:` 前缀与其他用途隔离；v2 可将 `cacheService` 换成共享存储实现。

## 4. 配置规则

- `vendor_id` 必填且必须存在。
- `vendor_model_id` 可选；提供时必须存在并属于对应 vendor。
- 未提供 `vendor_model_id` 时，按 `vendor_id + SgModel.name` 查找 vendor model：
  - `single`：找不到时由路由服务创建同名 vendor model。
  - `first_available`：必须在保存配置时匹配到 vendor model。
  - `load_balance`：不要求 vendor model 存在；请求时使用占位对象，不持久化 vendor_model 状态。
- 至少有一个启用上游；`single` 只能有一个启用上游。
- 同一个实际上游不能重复配置。
- `enabled` 缺省为 `true`。
- `failover.enabled` 缺省为 `true`。

创建和更新请求必须提交完整的 `routing_mode / routing_config`。

## 5. 路由服务

`modelRoutingService.selectUpstream(model, format)`：

1. 解析启用的上游并确定实际 vendor model 和协议。
2. 根据内存中的健康状态排除冷却中的候选。
3. 调用 `routing_mode` 对应的策略类。
4. 返回 `ModelRoutingResult`，携带 `vendorId`、`vendorModelName` 和 `supportedFormats`；无可用上游时返回上游字段为 `null` 的空结果（`ModelRoutingResult.none()`），由调用方判断后抛出 `503`。

策略接口：

```typescript
abstract class BaseRoutingStrategy {
    abstract selectUpstream(
        model: SgModel,
        candidates: ModelRoutingResult[],
    ): ModelRoutingResult;
}
```

策略只负责选择，不读取数据库、不发送请求、不写健康状态：

- `single`：返回唯一候选。
- `load_balance`：等概率随机返回一个候选。
- `first_available`：返回候选列表中的第一个（候选列表保持 `routing_config.upstreams` 的配置顺序，并已剔除冷却中的上游）。
- 候选为空时返回 `ModelRoutingResult.none()`（`vendorId` / `vendorModelName` 为 `null`），不再返回 `null`。

路由服务先按每个上游的协议健康状态过滤模型，再交给策略选择。

## 6. 请求与失败切换

`senderService.sendRequest` 负责重试编排：

1. 调用路由服务选择目标。
2. 查询 vendor model 和 vendor。
3. 调用 `sendRequestToUpstream` 执行一次请求。
4. 可重试失败时：
   - 写入内存冷却状态（冷却失败目标）——**无论 `failover.enabled` 是否开启**，失败标记都会生效。
   - `failover.enabled = true`：回到步骤 1，冷却中的目标会在重新选择时被过滤。
   - `failover.enabled = false`：返回失败响应，不重试；但该上游仍被标记冷却，后续请求和其他模型会避开它。
5. 没有可用目标时返回 503。

`sendRequestToUpstream` 保留原发送流程，只增加路由返回的 vendor model ID 参数。它仍负责创建和更新本次尝试的 record。

可重试 HTTP 状态码：`401、403、408、429、500、502、503、504`。网络请求失败同样按上述规则处理；客户端主动断开不切换。收到成功的流式响应后不再切换。

每次可重试失败写入内存健康表：

```typescript
healthStore.set(`${vendorId}:${vendorModelName}:${upstreamFormat}`, now);
```

冷却时间由 `UPSTREAM_FAILURE_COOLDOWN_MS` 控制。冷却到期后自动恢复；成功请求不修改健康状态。

**自动上游**：未指定 `vendor_model_id` 的自动上游同样以 `vendor_id` 为 key 记录冷却，因此 `failover.enabled` 切换对它们同样生效。

每次上游尝试创建一条 record，只有成功响应产生 usage 和费用。

## 7. API 与迁移

创建和更新接口接受：

```json
{
    "name": "claude-sonnet",
    "routing_mode": "first_available",
    "routing_config": {
        "upstreams": [
            { "vendor_id": 3, "vendor_model_id": 101, "enabled": true },
            { "vendor_id": 8, "enabled": true }
        ],
        "failover": {
            "enabled": true
        }
    }
}
```

controller 直接用请求 JSON 构造 `SgModel`。Sutando custom cast 负责 `routing_config` 与配置类之间的转换，数据库关联和路由规则由 service 校验。

迁移（单条 `migrate_0026.sql` 一次完成）：

1. 新增 `routing_mode` / `routing_config` 列，两列缺省均为 `NULL`，不依赖 DB 默认值，实际值由应用代码在保存时写入。
2. 将每个已有 model 的 `vendor_id / vendor_model_id` 包装成一个 `single` 上游：显式写入 `routing_mode = 'single'` 和含 `failover` 对象的 `routing_config`（未配置过上游的 model 两列保持 `NULL`）。
3. 删除 `vendor_id` / `vendor_model_id` 两个顶层字段。后续只以 `routing_config.upstreams` 为准。

## 8. 验收重点

- 三种策略选择规则正确，且都支持只有一个启用上游。
- 自动和显式 vendor model 解析正确（`single` 自动创建、`first_available` 保存时校验、`load_balance` 占位）。
- 不同上游使用各自的 URL、Token、模型名和协议。
- 可重试失败总是更新对应协议的冷却状态；`failover.enabled = true` 时重新路由，`false` 时本次失败直接返回（但冷却仍生效）。
- `load_balance` 等概率选择，`first_available` 按数组顺序切换。
- 自动上游（无 `vendor_model_id`）同样参与冷却与 `failover.enabled` 切换。
- 每次尝试保存一条 record。
- Node 和 Worker 模式行为一致。

## 9. 后续规划（v2）

- 更多选择策略：`least_busy`（当前并发在途最低）、`latency_based`（最近延迟最低）。需要为上游增加运行时指标（在途计数、延迟历史），并处理 Node / Worker 多进程下指标一致性问题。
- per-model 的失败处理配置（冷却时长、允许失败次数等）——直接扩展 `failover` 对象；当前使用全局常量 `UPSTREAM_FAILURE_COOLDOWN_MS` / `RETRYABLE_UPSTREAM_STATUS_CODES`。
