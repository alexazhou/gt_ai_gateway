# 直接用「渠道/模型ID」调用（临时模型，不写数据库）- 技术文档

## 架构概览

现在请求必须对应一个已登记的模型，真正卡住这一点的其实只有一处：**记录表的 `model_id` 不能为空**。请求链路本身（路由、协议转换、计费、规则、插件）只需要拿到一个模型**对象**，并不关心这个对象是不是数据库里的行。

因此方案是「请求期间用临时模型 + 记录侧放宽」：

```
请求 → llmApiMiddleware.requireLlmRequestContext
     → llmRequestService.resolveContext
        ├─ 按完整模型名查模型表（listByName）
        │    ├─ 有启用的 → 用它
        │    ├─ 只有停用的 → 403 model disabled
        │    └─ 没有 → 404 model not found
        │         （名字含 "/" 且直连开关开启时，改为尝试直连解析，详见「查找顺序」）
        └─ 返回 modelConfig —— 协议转换 / 计费 / 插件零改动
           （路由与记录侧需少量配合，见「既有链路需要配合改动的地方」）
     → 记录侧：record.model_id 可空 + model_name 快照（唯一需要改表结构的地方）
```

分层沿用既有约定：`controller → service → manager → model`。

## 现状链路（改动点定位）

| 环节 | 位置 | 行为 |
|------|------|------|
| 解析模型名 | `llmApiMiddleware` → `llmRequestService.resolveContext`（`src/service/llmRequestService.ts`） | `modelManager.getModel(name, true, scope)` 按名字查；查不到就写一条 `model_not_found` 失败记录，然后返回 404 |
| 选上游 | `routingService.selectUpstream` | 按模型的 `routing_config.upstreams` 选渠道（负载均衡 / 故障切换 / 冷却） |
| 上游模型名 | `senderService` | `vendorModel?.model_id ?? model.name`，并写回请求体（`bodyJson.model = vendorModelName`） |
| 记 录 | `recordService.create` | 模型类和 `recordService.create` 本来就允许 `model_id` 为 null（`model not found` 时就是这么写的），但数据库列还是 NOT NULL（`migrate_0002`，两种数据库都一样） |
| 计费 | `usageUtils.calculateCost(model, ...)` | 按模型的 `prices` 计价；无价格则 0 |

## 解析与查找

### 解析函数

```ts
// 按第一个 "/" 切分：前半渠道名，后半整体为模型 ID（可继续含 "/"）
// "A/Qwen/Qwen2.5-7B" → { vendorName: "A", modelId: "Qwen/Qwen2.5-7B" }
// "gpt-4o-mini"（无 "/"）→ null（不进入直连分支）
// "A/"（空模型 ID）/ "/x"（空渠道名）→ null，按现状 model not found 处理
function parseDirectModelRef(modelName: string): { vendorName: string, modelId: string } | null;
```

模型名仍然允许含 `/`：**先按完整模型名查模型表，确认没有这个模型之后才尝试直连解析**（见查找顺序），所以带 `/` 的存量模型不受影响。

### 查找顺序（接入 `resolveContext`）

查找统一走 `modelManager.listByName(name, scope)`：**一次查询**返回该名字下的所有模型（本租户优先、其次 main 租户共享模型，排序与现有 `getModel` 一致），再在内存里判断。

1. 按完整请求名查一次：
   - 结果里有启用的模型 → 用第一个（与现有 `getModel(modelName, true, scope)` 的行为一致）；
   - 没有启用的、但列表非空 → 模型存在但已停用 → 写 `model_disabled` 失败记录，返回 **403 `model disabled`**。这一步对所有 LLM 请求都生效，**与直连开关无关**，名字里有没有 `/` 都一样；
   - 列表为空 → 模型完全不存在，进入第 2 步。
2. 模型完全不存在：
   - 名字不含 `/` → 现状 `model not found`（404）；
   - 名字含 `/` → 读直连开关 `configService.isDirectVendorModelCallEnabled()`（内存缓存，见「配置开关」）：
     - **开关关闭 → 和现在一样**：写一条 `model_not_found` 失败记录，返回 404（日志里记下「直连调用开关关闭」）；
     - 开启 → 按 `渠道/模型ID` 解析：
       - 渠道：用 `vendorManager.findByName(渠道名, scope.tenantId)` 查（方法已存在，见 `src/manager/vendorManager.ts`）。渠道只按调用方自己的租户查，没有跨租户共享。查不到就写一条 `model_not_found` 失败记录并返回 404；**具体是「渠道不存在」只写服务端日志，不告诉客户端**；
       - 同名模型：再 `listByName(模型ID, scope)` 查一次（这是另一个名字，无法和上一步复用）。有启用的 → 用第一个；没有启用的但列表非空 → 写 `model_disabled` 失败记录，返回 **403 `model disabled`**；列表为空 → 构造临时模型。

`listByName` 要按 `getModel` 的同一套租户过滤与排序实现（`filterByTenantScope` + 本租户优先），不能自己另写一套「只查本租户」的查询，否则会漏掉 main 租户的共享模型。可以把它加在 `modelManager` 里，和现有 `getModel` 共用这段过滤逻辑。

同名候选最多只有几条（本租户一条，最多再加 main 租户的共享模型），一次全部取回没有性能负担。普通调用仍然只查一次；只有直连解析出的模型 ID 和请求名不同时，才需要按新名字再查一次。注意 `enable` 在 SQLite / MySQL 下可能以 0/1 返回，判断时用真值（`if (model.enable)`），不要写 `model.enable === true`。

**`model disabled` 的错误体**：HTTP 403，`message` 为 `model disabled`，`code` 要显式传 `model_disabled`。原因是 `buildLlmErrorResponse` 会把所有 403 默认映射成 `authentication_error`（见 `customError.ts`），不显式传 code 的话客户端会误以为是鉴权问题。失败记录的 `failed_code` 写 `model_disabled`，`model_id` 填这个停用模型的 id（模型确实存在），`model_name` 仍存客户端原文。

### 配置开关

沿用既有模块开关的完整机制（`ConfigKey` 枚举 + `CONFIG_DEFAULTS` 默认值 + 便捷读取 + 设置页 CRUD，缓存即时失效）：

- `ConfigKey.DIRECT_VENDOR_MODEL_CALL_ENABLED = "direct_vendor_model_call_enabled"`；
- **默认值 `"false"`**（`configService.ts` 的 `CONFIG_DEFAULTS`）——存量部署升级后，除「停用模型报 `model disabled`」这一处统一修正外行为不变；直连是需要手动打开的新功能；
- 便捷读取 `isDirectVendorModelCallEnabled()`（模式同 `isMultiTenantEnabled` / `isModuleBillingEnabled`）；
- 开关为**全局单份**（config 表无租户维度，与既有开关一致），不按租户区分。

## 临时模型构造

构造一个 `SgModel` 实例（**不 `save()`**），字段：

| 字段 | 值 | 说明 |
|------|-----|------|
| `id` | 空 | 不在数据库里；后面所有用到 `id` 的地方都要能接受它是空的（见「规则怎么处理未登记的模型」「记录创建」） |
| `name` | 模型 ID（去掉渠道前缀） | 上游收到的 model 就是它（沿用 `senderService` 现有逻辑） |
| `tenant_id` | `scope.tenantId` | 调用方所属租户 |
| `enable` | true | |
| `routing_mode` | `SINGLE` | 只有一条路径，不做负载均衡 |
| `routing_config.upstreams` | `[{ vendor_id: <该渠道>, vendor_model_id: undefined, enabled: true }]` | 没有 `vendor_model` 时，上游模型名用 `model.name`（`senderService` 现有逻辑） |
| `routing_config.failover.enabled` | false | 直连不切渠道 |
| `prices` | `{}` | cost = 0（见「计费」） |
| `isTransient` | true | 临时模型标记（`SgModel` 新增属性，不是数据库字段）：路由看到它就跳过 `vendor_model` 自动补全（见「路由」一节） |

构造好之后，**协议转换、计费、插件都不用动**——它们只需要一个模型对象。网关当前没有模型级的响应缓存，不需要为直连做缓存处理（`cache_read` 只是价格项）。

建议把临时模型构造抽为独立函数（如 `llmRequestService` 内的 `buildDirectModel` / 独立 `resolveDirectModel`），便于单测。

## 既有链路需要配合改动的地方

实际核对代码后发现，路由和记录侧共有三处必须配合改：

### 路由：跳过 vendor_model 自动补全

`routingService/core.ts` 的 `resolveAvailableCandidates` 里有一段：SINGLE / FIRST_AVAILABLE 模式下，如果上游没指定 `vendor_model_id`、按模型名又查不到 `vendor_model`，它会**自动插一条 `vendor_model`**（本来是给「自动上游」补登记的）。临时模型正好会走到这里：每调一个新模型 ID，渠道的模型列表里就会凭空多一条记录，既违背「不写数据库」的承诺，也会出现在渠道测试弹窗的模型下拉里。

处理：给临时模型加一个标记（如 `SgModel` 上挂 `isTransient = true`），路由看到这个标记就**跳过**自动补全——`vendorModel` 保持 null，上游协议格式改用渠道级的 `getSupportedFormats()` 判断，上游模型名用 `model.name`，正好就是直连想要的效果。不要为了绕开这个问题把路由模式改成 `LOAD_BALANCE`：产品上直连就是 SINGLE，而且请求时间线里会显示成 `load_balance`。

### 记录创建：`modelConfig.id` 为空

`senderService.sendRequest` 建记录时（`recordService.create(user.id, modelConfig.id, ...)`）和 `llmApiMiddleware` 里两处规则拒绝时写的失败记录，都直接传了 `modelConfig.id`。临时模型没有 id，这几处统一改成 `modelConfig.id ?? null`。

### 快照名：必须用「客户端原文」，不能用 `modelConfig.name`

直连时，`modelConfig.name` 已经被去掉了渠道前缀，是 `gpt-4o-mini`，不是客户端写的 `A/gpt-4o-mini`，不能直接当快照。另外，`recordFailedRequest` 虽然有个 `modelName` 参数，但代码里目前根本没用到它（只传了 modelId），四个调用点传的也都是 `modelConfig.name`。

处理：`llmApiMiddleware` 解析出请求里的模型名后，先把它放进请求上下文（如 `c.set("requestedModelName", modelName)`）。所有写记录的地方优先用这个值；没有这个值时才用 `modelConfig.name`（比如模型路由测试这种不经过 LLM 中间件的入口）。

## 规则怎么处理未登记的模型

`ruleService` 存规则上下文时写的是 `model_id: Number(modelConfig.id)`（见 `src/service/ruleService.ts` 的 `matchAndCheck` / `matchAndCheckVendor`）。临时模型没有 id，`Number(undefined)` 会得到 NaN：

- `!=` / `not in` 碰到 NaN **永远返回 true** —— 于是「排除某模型」的规则反而会对直连生效，和产品承诺的「按模型绑定的规则一律不生效」矛盾。

所以这次必须明确：没有登记模型的直连请求，规则该怎么算：

1. **`ctx.model_id` 直接用 `modelConfig.id ?? null`**，不再 `Number()` 强转，避免出现 NaN；
2. **`scopeExpr.matchCondition` 遇到 `actual == null` 一律返回 false**（所有运算符都一样）。意思是：`model_id` 这类条件在直连请求上永远不成立，按模型配的规则（包括 `!=` / `not in` 这种反向条件）都对直连不生效；
3. **按用户维度、或全局兜底（`const true`）的规则照常生效**（限流和访问控制都是）。`model_id` 为空不影响其它条件的判断，`and` / `or` 的算法不用改。

## 记录侧改动

### 迁移（`migrate_0033`，编号以实现时最新为准）

1. `record.model_id` 由 NOT NULL 放宽为**可空** —— 模型层与 `recordService.create` 本来就能接受 null，迁移只改 DB 列；调用方怎么传值见「记录创建」；
2. 新增 `record.model_name`（快照列）：SQLite `TEXT NULL` / MySQL `VARCHAR(512) NULL`。直连时存的是「渠道名 + `/` + 模型 ID」，可能比 `model.name` 的 255 更长，所以放宽到 512。不建索引（这次不按原文筛选）。

方言与执行路径：

- **SQLite 沿用既有迁移模式**（同 `migrate_0029` 的 cost 列改造）：**先加新列、再删旧列**，不做整表重建——
    ```sql
    -- 新增快照列（新列，无数据可迁）
    ALTER TABLE record ADD COLUMN model_name TEXT NULL;

    -- 放宽 model_id：加可空新列 → 迁数据 → 删旧列 → 改回原名
    ALTER TABLE record ADD COLUMN model_id_new INTEGER NULL;
    UPDATE record SET model_id_new = model_id;
    ALTER TABLE record DROP COLUMN model_id;
    ALTER TABLE record RENAME COLUMN model_id_new TO model_id;
    ```
    注意：`model_id` 不在任何索引或约束里（record 现有索引只涉及 tenant_id 和 created_at），可以直接 `DROP COLUMN`。替换后 `model_id` 会跑到表末尾，但 ORM 是按列名取值的，没有影响。
- **MySQL 用 `ALTER TABLE`** 原地改：
    ```sql
    ALTER TABLE `record` MODIFY COLUMN model_id BIGINT NULL;
    ALTER TABLE `record` ADD COLUMN model_name VARCHAR(512) NULL;
    ```
- **worker（D1）复用同一份 sqlite.sql**，由 `wrangler d1 execute` 执行（见 `dbMigrationService.ts`）；`ADD COLUMN` / `UPDATE` / `DROP COLUMN` / `RENAME COLUMN` 均为既有迁移（`migrate_0026` / `migrate_0029`）已在用的语句，D1 兼容性有先例可循。

老记录不回填：历史数据的 `model_name` 是空的，读取时再用 `model_id` 去模型表查当前名字（名字可能已经改过，可以接受）。

### 写入与读取

- **写**：所有创建记录的地方都写入 `model_name`，存客户端请求里的模型名原文（直连是 `A/gpt-4o-mini`）：
    - `recordService.create` 新增一个**可选末参** `modelName?: string | null`。不要插在参数中间：`tests/integration/recordService.node.test.ts` 等 10+ 处是按位置调用的；
    - `recordFailedRequest` 的 `modelName` 参数现在没被用到，实现时要真的传进 `create`；
    - 调用方怎么取值见「快照名」：优先用请求上下文里的 `requestedModelName`，没有时用 `modelConfig.name`；
    - 临时模型的 `model_id` 传 null（`modelConfig.id ?? null`）。
- **读**：记录列表 / 详情返回 `model_name`；模型列**优先显示快照**，快照为空（老记录）才去模型表查当前名字；`model_id` 也为空时前端标「未登记模型」。`vendor_id` / `vendor_model_name` 保持现状（每次上游尝试都会覆盖，用来回答「实际打到了哪个渠道的哪个上游模型」），和快照配合就能完整还原当时的现场。
- **统计**：仍按 `model_id` 聚合；`COUNT(DISTINCT model_id)` 天然忽略 NULL，直连调用不单独归组，也不计入仪表盘「今日活跃模型」（图例用模型表当前名）。
- **筛选**：`model_ids` 过滤不变（只匹配已登记记录）；按 `model_name` 原文加筛选项属可选前端增强，本期不做。

### 改动清单（后端）

| 文件 | 改动 |
|------|------|
| `src/constants.ts` | 新增 `ConfigKey.DIRECT_VENDOR_MODEL_CALL_ENABLED`；`FailedCode` 增加 `MODEL_DISABLED = "model_disabled"` |
| `src/service/configService.ts` | `CONFIG_DEFAULTS` 加默认值 `"false"`；新增 `isDirectVendorModelCallEnabled()` |
| `src/manager/modelManager.ts` | 新增 `listByName(name, scope)`：返回同名的全部候选（租户优先），与 `getModel` 共用租户过滤与排序 |
| `src/service/llmRequestService.ts` | 用 `listByName` 一次查询后判断启用/停用/不存在；直连解析、读开关、构造临时模型 |
| `src/model/sgModel.ts` | 新增 `isTransient?: boolean`（不是数据库字段） |
| `src/service/routingService/core.ts` | 遇到 `isTransient` 的模型跳过 `vendor_model` 自动补全 |
| `src/service/ruleService.ts` | `ctx.model_id` 改为 `modelConfig.id ?? null` |
| `src/util/rule/types.ts` | `RequestContext.model_id` 允许 `null` |
| `src/util/rule/scopeExpr.ts` | `matchCondition` 收到 `null` 时一律返回 false |
| `src/model/sgRecord.ts` | 新增 `model_name!: string \| null` 属性，并把 `model_name` 加入 `RECORD_SUMMARY_COLUMNS`（否则列表接口不返回快照） |
| `src/manager/recordManager.ts` | `RecordCreateData` 增加 `model_name?: string \| null` |
| `src/service/recordService.ts` | `create` 增加可选末参 `modelName`；`recordFailedRequest` 把已有但未使用的 `modelName` 真正写入 create |
| `src/service/senderService.ts` | 建记录时 `modelId = modelConfig.id ?? null`，并传原文快照名 |
| `src/middleware/llmApiMiddleware.ts` | 写入 `requestedModelName`；两处规则拒绝时写的记录改用 `modelConfig.id ?? null` 和客户端原文名 |
| `src/controller/statsController.ts` | `recentRecords` 的简化映射补 `model_name`（否则仪表盘「最近记录」的模型列对直连为空） |
| `src/service/vendorService.ts` + `src/controller/vendorController.ts` | 抽一个共用的渠道名校验（拒绝含 `/`），创建和更新都调用 |

## 渠道名校验

创建渠道在 `vendorController.createVendor`、更新在 `vendorService.updateVendor`（两处不在同一层）。建议在 `vendorService` 抽一个 `validateName()` 供两边调用，拒绝含 `/` 的名字（400 类 AppError，与现有重名校验同风格）。无迁移，只挡新增 / 改名。

存量数据里若已有含 `/` 的渠道名：不迁移、不清洗，但**该渠道无法通过直连语法调用**——`A/B/x` 会按第一个 `/` 解析成渠道 `A` + 模型 `B/x`，甚至可能命中另一个真实存在的渠道 `A`。使用文档中注明这一点。

## 计费

临时模型 `prices = {}` → `usageUtils.calculateCost` 走现有「无价格则 0」路径，cost = 0，usage 照常记录。要计费就建同名模型配价格（见「查找顺序」中的同名模型复用）。

## 上游与协议

- 上游格式：沿用 `resolveUpstreamFormat(clientFormat, vendor.getSupportedFormats())` 同一套规则（含回退转换）；
- 上游模型名：请求体里的 `model` 会被改写成「去掉渠道前缀」的模型 ID（`senderService` 现在就是这么做的：没有 `vendor_model` 时取 `model.name`）；
- 不涉及 `vendor_model.allowed_formats`（没有 vendor_model 记录）；
- 渠道没有启用开关（vendor 没有 enable 字段），所以不用判断「渠道是否启用」。另外，直连用的是 SINGLE 路由，而 SINGLE 本来就不看冷却状态——健康冷却（key 是 vendor + 上游模型名）对直连**没有实际作用**。失败标记还是会写，但下一次直连照样会选这个渠道。

## 前端改动

- 设置页：新增「直连调用」开关（与计费 / API playground 等模块开关同一入口，默认关）。
- 记录列表 / 详情 / 仪表盘「最近记录」：`stores/record.ts` 的 `enrichRecords` 和 `fetchRecordDetail` 目前会无条件反查并覆盖模型名（不是 `useRecordTable`），要改成「有快照就直接用，不再反查、不再覆盖」；`model_id` 为空时显示「未登记模型」。
- 渠道表单：名称输入校验 / 提交报错提示不允许 `/`。
- 失败码展示：`FAILED_CODE_LABELS` 增加 `model_disabled: '模型已停用'`，记录列表 / 详情里能直接看出原因。
- 不新增页面、不加 `model_name` 筛选（可选增强，本期不做）。

## 文档改动

- `doc/usage/LlmApiUsage.md`：新增直连调用一节（语法、查找顺序、开关默认关闭需开启、不计费 / 无 LB、如何升级成同名模型）。
- `doc/usage/ConfigurationGuide.md`：设置开关说明。

## 技术要点与边界

1. **解析规则**：按第一个 `/` 切分，模型 ID 可继续含 `/`；空渠道名 / 空模型 ID 视为不合法（null），走现状 `model not found`。
2. **同名模型一次查完**：`listByName` 取回候选后在内存里判断，不要为了区分启停查两次库。
3. **渠道只按调用方租户查**：vendor 没有跨租户共享，`findByName(name, tenantId)` 就够用了。
4. **没有登记模型时，规则怎么算**：`ctx.model_id = id ?? null`；`matchCondition` 遇到 null 一律返回 false（正反运算符都一样）；用户维度、全局规则照常生效。**不能依赖 `Number(id)` 的隐式行为**，因为 NaN 会让 `!=` / `not in` 命中。
5. **开关只控制直连分支**：「停用模型报 `model disabled`」对所有请求统一生效，不受开关影响。
6. **不写数据库**：临时模型不 `save()`。另外两个方案已经排除：「第一次调用时自动创建模型」会把拼错、临时试用的名字也存进模型表；「用 `model_id = 0` 当特殊值」则要每个读记录的地方都记得 0 是特殊的。
7. **快照对所有记录生效**：不只直连——普通调用也冻结当时的模型名，解决「改名牵动历史记录 / 删除后查不出名字」。
8. **`/llm/v1/models` 不列直连模型**（列表只来自模型表），客户端自动发现看不到，属预期。
9. **同名模型优先，可能忽略客户端指定的渠道**：存在同名多上游模型时，`A/gpt-4o-mini` 会走那个模型（可能分配到其它渠道）。这是「平滑升级」的代价，产品文档已写明。
10. **迁移注意**：SQLite 不整表重建，沿用「加新列 → 迁数据 → 删旧列 → 改回原名」的既有模式（同 `migrate_0029`）；D1 与 node SQLite 共用同一份 sqlite.sql；实现前以仓库最新迁移编号为准（写作时为 `migrate_0032`）。

## 测试影响

- 单元测试：解析函数（含 `/` 的模型 ID、无 `/`、空串 / 空段、多个 `/`）、`matchCondition` 对 null 的四运算符行为、临时模型构造字段、开关默认值（未配置时 `false`）。
- 集成 / 端到端（对应产品验收）：
  - **开关关闭（默认）**：`A/gpt-4o-mini`（模型完全不存在）→ 404 `model not found`（与迭代前一致），日志带「直连调用开关关闭」原因；开启后放行，关闭 / 开启即时生效（config 缓存失效）；
  - **停用模型统一报错**：不带 `/` 的普通调用、带 `/` 的完整名字、解析出的同名模型，只要存在但已停用，都返回 403 `model disabled`，错误体 `code = model_disabled`、失败记录 `failed_code = model_disabled`，与开关状态无关；同名模型删除后才走临时模型；
  - 直连成功 + record 字段断言（`model_id` null、`model_name` 快照、`vendor_id` / `vendor_model_name`、cost = 0）；
  - **直连不写 `vendor_model`**：调用前后该渠道的 `vendor_model` 记录数不变（专门覆盖 SINGLE 模式会自动补全的那段逻辑）；
  - **失败记录的快照名**：模型停用、规则拒绝、余额不足、上游失败这几类失败记录的 `model_name` 都是客户端原文（`A/gpt-4o-mini`），不能是去掉渠道前缀后的模型 ID；
  - 记录列表 / 最近记录接口返回 `model_name` 快照；前端 `enrichRecords` / `fetchRecordDetail` 在有快照时不再覆盖；
  - 渠道不存在 → 404 `model not found`（响应不区分原因，日志有具体原因）；
  - 同名模型优先（建同名带价格 LB 模型后再调，计费 > 0、多上游分配、模型规则生效）；
  - 模型改名 / 删除后旧记录显示旧名（快照）；
  - 模型维度（含 `!=` / `not in`）规则对直连不生效、用户维度规则照常生效；
  - 三端点直连（含协议回退转换组合）；
  - 渠道名含 `/` 创建 / 更新被拒；
  - 迁移：SQLite（含重建表数据无损）/ MySQL / D1（wrangler 路径）三形态可执行。
- 回归要求：开关关闭时（包括升级后没有打开的存量部署），除「停用模型现在报 `model disabled`」这一处统一修正外，其余请求行为和改动前一致；打开后只要没人用直连语法，行为也不变。

## 相关文档

- [产品文档](./step1_product.md)
- 开发任务表（step3_tasks.md，待实现时补写）
