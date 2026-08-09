# 请求记录与活动日志重构 — 设计文档

> 状态：设计中，尚未编码
>
> 关联：`doc/design/upstream_failover_last_error_design.md`、`doc/design/model_multi_upstream_routing_design.md`

## 1. 背景与问题

### 1.1 问题一：一次用户请求产生多条记录

当前 `sendRequestToUpstream`（`senderService.ts`）每次上游尝试都调用 `recordService.create` 新建一条记录。一个用户请求在 failover 下尝试 N 个上游，就会产生 **N 条 record**。

- 违背"一条记录 = 一次用户请求"的语义；
- 记录列表被中间失败尝试刷屏，难以回答"这次请求最终结果如何"；
- 成功/失败尝试混在多条记录里，最终结果不突出。

### 1.2 问题二：缺少请求处理过程记录

没有地方按请求记录处理过程：路由选了哪个上游、每个上游尝试的状态/错误、失败切换、插件修改、协议转换等。排查问题时只能翻应用日志，无法按请求追溯。

## 2. 目标

1. **一次用户请求 = 一条 record**：跨上游尝试更新同一条记录，只保留最终结果。
2. **新增 `request_activity` 表**：记录单次请求的处理过程（路由、上游尝试、失败切换、插件、转换、结果）。
3. 中间尝试的细节（哪个上游、什么状态码、什么错误）落到 activity，而不是 record。

## 3. 现状分析

### 3.1 record 生命周期（当前）

```
sendRequestToUpstream
  ├─ recordService.create(user, model, body, clientFormat, upstreamFormat, vendorId, vendorModelName)   // 每次尝试一条
  ├─ recordService.update(id, { status: PROCESSING, start_at })
  ├─ (fetch 失败) recordService.update(id, { status: FAILED, response_data, end_at })
  └─ 响应处理 (responseHandlerService)
       └─ recordService.update(id, { status: SUCCESS/FAILED, response_data, usage, cost, end_at, first_token_latency })
```

### 3.2 record 字段（`sgRecord.ts`）

| 字段 | 含义 |
|------|------|
| user_id / model_id | 用户 / 网关模型 |
| vendor_id / vendor_model_name | 命中的上游（当前每条记录记录各自尝试的上游） |
| client_format / upstream_format | 客户端 / 上游协议 |
| request_data / response_data | 请求/响应体（payload 存 object storage，`storage_record` 表） |
| status | `init` / `processing` / `success` / `failed` |
| failed_code | 失败原因分类 |
| usage / cost / first_token_latency / start_at / end_at | 计费与耗时 |

### 3.3 相关调用点

- `senderService.sendRequestToUpstream`：create + PROCESSING + fetch 失败 FAILED
- `responseHandlerService`（4 个 handler）：最终 SUCCESS/FAILED + usage/cost
- `recordController.listRecords` / `recordService.latest`：列表展示

## 4. 方案

### 4.1 一次请求一条记录

**record 创建时机上移到 `sendRequest`**（进入路由循环前，只创建一次）：

```
sendRequest
  ├─ recordService.create(user, model, body, clientFormat)      // status=init, start_at=now，此时还不知道上游
  ├─ requestActivityService.append(...)                            // 记录请求开始
  ├─ 路由循环（while true）
  │    ├─ selectUpstream → 每次尝试 sendRequestToUpstream(..., record)
  │    │     ├─ recordService.update(record.id, { status: PROCESSING, vendor_id, vendor_model_name, upstream_format })
  │    │     ├─ requestActivityService.append(...)                 // 记录本次上游尝试
  │    │     └─ (fetch 失败) recordService.update(record.id, { status: FAILED, response_data, end_at })
  │    └─ failover → requestActivityService.append(...)            // 记录切换
  ├─ 无可用上游 → recordService.update(record.id, { status: FAILED, end_at }) + activity
  └─ 最终响应处理（responseHandlerService，仍是同一条 record）
        └─ recordService.update(record.id, { status: SUCCESS/FAILED, response_data, usage, cost, end_at })
```

要点：

- `recordService.create` 改为**不含上游信息**（路由后才有）；`vendor_id` / `vendor_model_name` / `upstream_format` 在每次尝试时 `update` 覆盖，最终保留**最后一次尝试**（即最终命中的上游）。
- `status` 流转：`init → processing → success/failed`，同一条记录。
- `response_data` / payload（storage）每次 update 覆盖，最终 = 成功响应或最后错误。
- **cost 只在成功时记录**（失败尝试无 usage，不产生费用）；`deductBalance` 只在最终成功路径执行，不会重复扣费。
- **无可用上游也要建记录**并标记 FAILED（`failed_code = no_available_upstream`，`FailedCode` 新增该枚举值），因为这也是一次真实请求。
- 中间失败的细节进 activity，不进 record。

**`sendRequestToUpstream` 签名变化**：去掉 `recordService.create`，改为接收 `record` 参数并 `update`。

### 4.2 `request_activity` 活动日志表（新表）

**一个 record 对应一行** `request_activity`，`activities` 字段是 **JSON 数组**，顺序存储该请求的全部活动消息（读取 → 追加 → 写回）。

```sql
CREATE TABLE request_activity (
    record_id  INTEGER PRIMARY KEY,        -- 与 record 逻辑关联（不用外键）
    activities TEXT NOT NULL,              -- JSON 数组：该请求的全部活动消息
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
```

`activities` 数组里每个元素的结构：

```json
{
    "stage": "upstream_attempt",   // routing / upstream_attempt / failover / plugin / conversion / result
    "level": "warn",               // info / warn / error
    "message": "上游返回 402",
    "details": { "vendor_id": 7, "url": "https://..." },
    "ts": 1786263572000            // epoch ms
}
```

模型 `SgRequestActivity`（`src/model/sgRequestActivity.ts`，table = `request_activity`，`record_id` 为主键、**无外键**），
服务 `requestActivityService`（`src/service/requestActivityService.ts`，默认导出）：

```typescript
async function append(
    recordId: number,
    stage: RequestActivityStage,
    message: string,
    details?: Record<string, unknown>,
    level: ActivityLevel = ActivityLevel.INFO,
): Promise<void>
```

实现要点：

- `append` 读取该 record 现有的 `activities` JSON 数组 → 追加一条（含 `ts`）→ 写回；行不存在则创建（upsert by record_id）。
- **无外键、无级联删除**：删除用户/记录时 activity 行由业务逻辑一并清理，或保留为按 `record_id` 逻辑关联的数据。
- 同一次请求内的 `append` 是顺序执行的（请求处理串行），读改写无竞态。
- **关键约束：写入必须是 best-effort**——日志失败绝不能导致请求失败（内部 try/catch 吞掉并 console.warn）。

**前端读取**：`requestActivityService.getByRecordId(recordId)` 返回 `activities` 数组，新增接口 `GET /record/:id/activity.json`（admin），记录详情页展示处理过程时间线。

### 4.3 stage 枚举与写入时机

常量（`constants.ts`）：

```typescript
export enum RequestActivityStage {
    ROUTING = "routing",             // 路由选择 / 无可用上游
    UPSTREAM_ATTEMPT = "upstream_attempt", // 单次上游请求及其结果
    FAILOVER = "failover",           // 失败切换
    PLUGIN = "plugin",               // 插件修改
    CONVERSION = "conversion",       // 协议转换
    RESULT = "result",               // 最终结果
}
export enum ActivityLevel { INFO = "info", WARN = "warn", ERROR = "error" }
```

| 阶段 | 写入位置 | 内容示例 |
|------|---------|---------|
| routing | `sendRequest` 循环内每次 `selectUpstream` 后 | 选中上游 `{ vendor_id, vendor_model_name, upstream_format }`；无可用上游 `level=error` |
| upstream_attempt | `sendRequestToUpstream`（发起前 + 结果后） | `{ vendor_id, vendor_model_name, url, client_format, upstream_format, status?, duration?, error? }` |
| failover | `sendRequest` catch 里 failover 分支 | `{ 上次: vendor/url, 原因: status/error }` |
| plugin | `sendRequestToUpstream` 插件调用处（转换前/后） | `{ format, body_len_before, body_len_after }` |
| conversion | `sendRequestToUpstream` 转换处 | `{ from, to, converter }` |
| result | `responseHandlerService` 各 handler 最终分支 | `{ status: success/failed, failed_code?, cost }` |

### 4.4 与现有数据的关系

- **request/response body**：仍走 `storage_record`（record payload），activity 只记轻量事件，不存 body。
- **record 不新增字段**：现有字段已足够表达最终结果。
- 可选：给 record 加 `request_trace_id`（UUID）便于跨表/跨系统追踪——**暂缓，非必需**。

## 5. 行为对比

| 场景 | 当前 | 改后 |
|------|------|------|
| 单上游成功 | 1 条 record（success） | 1 条 record（success）+ N 条 activity |
| failover 后成功（上游 A 失败→B 成功） | 2 条 record（failed + success） | **1 条 record（success，vendor=B）** + activity 记录 A 失败、切换、B 成功 |
| 全部上游失败 | N 条 record（全 failed） | **1 条 record（failed，vendor=最后一次）** + activity 记录每次失败 |
| 无可用上游 | 0 条 record（直接抛错） | **1 条 record（failed）+ activity** |

## 6. 迁移

- 新增 `request_activity` 表（`record_id` 主键 + `activities` JSON 数组）：`resource/migrate/migrate_0027.sql`
- `record` 表：**无需改动**（现有字段够用）

## 7. 影响面与测试

**需要改动的文件：**

| 文件 | 改动 |
|------|------|
| `src/service/recordService.ts` | `create` 去掉上游参数（改为进入路由前创建） |
| `src/service/senderService.ts` | `sendRequest` 建 record + 记录 activity；`sendRequestToUpstream` 接收 record、去掉 create、按尝试 update + 记 activity |
| `src/service/responseHandlerService.ts` | 各 handler 最终分支记 activity（result 阶段） |
| `src/model/sgRequestActivity.ts`（新） | 活动日志模型（record_id 主键，无外键） |
| `src/service/requestActivityService.ts`（新） | 活动日志服务（append / getByRecordId） |
| `src/constants.ts` | `RequestActivityStage` / `ActivityLevel` 枚举；`FailedCode` 新增 `no_available_upstream` |
| `resource/migrate/migrate_0027.sql`（新） | `request_activity` 表 |

**测试影响**（`tests/api/model/model-routing.test.ts` 等断言 `records.body.total` 处）：

- failover 相关用例：`total` 从 2/3 变为 **1**，且断言 `list[0]` 的 vendor/status 改为"最终命中的上游"；中间失败改从 activity 断言。
- 新增：activity 数量与内容断言（每阶段一条）。
- 需全量扫一遍所有 `records.body.total` 断言（含 AI 测试、非路由测试）。

## 8. 决策记录

- [x] `failed_code` 新增 `no_available_upstream`
- [x] 插件/转换**只记调用事件**（不深入插件内部记录修改内容）
- [x] **activity 暴露给前端**：记录详情页展示处理过程时间线（需要新增读取接口，如 `/record/:id/activity.json`）
- [x] **不加 `request_trace_id`**；用 `record_id` 逻辑关联，**不用外键**
- [x] **一个 record 对应一行 `request_activity`**，`activities` JSON 数组字段存储多条活动消息
