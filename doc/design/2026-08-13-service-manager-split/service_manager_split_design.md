> ✅ V1.9 专项设计：已排期实施。原为 `_planning/` 规划稿，随 V1.9 版本落地转为正式设计文档，推进节奏见 [step3_tasks.md](./step3_tasks.md)。

# Service / Manager 分层重构设计

## 1. 背景与目标

当前后端所有业务逻辑集中在 `src/service/` 下，但其中混入了大量「单纯的数据访问层（DAL）」逻辑：按条件查、列表、计数、增删改。同时部分 DAL 甚至直接散落在 controller 层（如 `vendorModelController` 有 15 处裸查询），绕过了 service 层。

本设计的目标：**新增 manager 层，把纯 DAL 逻辑从 service 中剥离，并顺带收编 controller 中的裸查询**，形成清晰的依赖层级：

```
controller → service（业务编排） → manager（DAL/持久化） → model（数据模型）
```

拆分标准：

- **manager 层（DAL）**：只做数据库读写原语 —— 按主键/唯一键查找、条件查询、列表、计数、创建、更新、删除。不含业务判断。
- **service 层（业务）**：校验、组合、跨实体事务、容错、规则判断。底层的 DAL 调用改为调 manager。

## 2. 现状 DAL 分布

### 2.1 service 层查询分布

统计 `src/service/**` 中的 `.query()` 直接调用：

| Service | `.query()` 次数 | DAL 占比 | 结论 |
|---|---|---|---|
| clientConfigService/core.ts | 13 | 混合 | 函数级拆分 |
| modelService.ts | 9 | ~60% | 函数级拆分 |
| vendorService.ts | 5 | ~20% | 函数级拆分 |
| userService.ts | 5 | ~30% | 函数级拆分 |
| objectStorageService.ts | 5 | ~15%（仅表操作） | 只拆表函数 |
| requestActivityService.ts | 4 | ~50% | 函数级拆分 |
| recordService.ts | 4 | ~65% | 函数级拆分 |
| configService.ts | 4 | ~25% | 只拆底层 DB 操作 |
| routingService/core.ts | 2 | ~15% | 查找下沉 |
| rechargeRecordService.ts | 2 | ~100% | 整体搬走 |
| configAdapterUtils.ts | 1 | 少量 | 随 clientConfig 一起 |

其余 service（senderService、responseHandlerService、vendorTestService、streamLogService、updateService、cacheService、upstreamHealthService、pluginService、hostService、llmRequestService）**无直接 DAL**，是纯编排/工具，无需改动。

### 2.2 controller 层裸查询分布

注：以下仅统计 ORM 裸查询（`SgXxx.query()` 和 `ormService.dbAdapter.prepare`），不含 `c.req.query()`（HTTP 请求参数解析）。

| Controller | ORM 裸查询数 | 说明 |
|---|---|---|
| vendorModelController | 15 | 全是对 `SgVendorModel`/`SgVendor` 的 CRUD，**连 service 都没有**，最该先收编 |
| vendorController | 7 | `SgVendor` 查询 |
| recordController | 6 | `SgRecord` 查询 |
| userController | 6 | `SgUser` 查询 |
| systemController | 4 | 各类查询（`SgUser`、`SgVendor`、`SgModel`、`SgRecord`） |
| statsController | 1 ORM + 2 raw SQL | 含 `ormService.dbAdapter.prepare` 的原生 SQL 聚合 |
| modelController | 2 | `SgModel` 查询 |

## 3. 逐 Service 拆分清单

### 3.1 整体搬走（纯 DAL）

**rechargeRecordService.ts（40 行）**

| 函数 | 去向 |
|---|---|
| `listRechargeRecords` | rechargeRecordManager |
| `getRechargeRecord` | rechargeRecordManager |

100% 纯 DAL，整个文件可直接改名 `rechargeRecordManager`。

### 3.2 函数级拆分（业务 + DAL 混合）

**requestActivityService.ts（82 行）**

| 函数 | 去向 |
|---|---|
| 抽出 DAL 原语：`findByRecordId`、`updateActivities`、`createActivity` | requestActivityManager |
| `append`（JSON 解析容错 + 活动条目组装 + best-effort 包装 + 读-改-写 upsert 编排） | 保留 service，底层改调 manager |
| `getByRecordId`（含 JSON 解析容错） | 保留 service，底层查询改调 manager |

**modelService.ts（148 行）**

| 函数 | 去向 |
|---|---|
| `getModel(name, enable?)` | modelManager |
| `listModels(options)` | modelManager |
| `hasModelsUsingVendor(vendorId)` | modelManager |
| `listEnabledModels()` | modelManager |
| `checkDuplicateEnabledModel(name, excludeId?)` | modelManager |
| `deleteModel(modelId)` | modelManager |
| `filterByVendor`（查询助手） | modelManager |
| `createModel`（dup 检查 + validatePrices + routingService.validateConfig） | 保留 service，save 下沉 |
| `updateModel`（同上） | 保留 service，save 下沉 |

**recordService.ts（162 行）**

| 函数 | 去向 |
|---|---|
| `create(userId, ...)` | recordManager |
| `update(recordId, data)` | recordManager |
| `latest(limit, summaryOnly)` | recordManager |
| `clearPayloads()` | recordManager |
| `readPayload` / `writePayload` | recordManager（payload 与表字段的读写归一到一处） |
| `attachPayload`（组合表 + 存储） | 保留 service |
| `recordFailedRequest`（容错包装） | 保留 service |
| 开关判断（isLogEnabled / isPayloadRecordingEnabled） | 保留 service |

**userService.ts（100 行）**

| 函数 | 去向 |
|---|---|
| `getUser(token)` | userManager |
| 抽出 `findById` / `updateBalance` / `createRechargeRecord` 原语 | userManager |
| `getUserByToken`（root 逻辑） | 保留 service |
| `adjustBalance` / `deductBalance` / `checkBalance`（余额业务） | 保留 service，底层改调 manager |
| `toUnits` / `isRootToken` | 保留（纯函数） |

**vendorService.ts（169 行）**

| 函数 | 去向 |
|---|---|
| `getVendorByName(name)` | vendorManager |
| 抽出 `listAll`（供 findVendorByUrl 匹配用） | vendorManager |
| `updateVendor`（proxy 校验 + JSON 序列化） | 保留 service，find/update 下沉 |
| `findVendorByUrl`（匹配逻辑） | 保留 service |
| `fetchUpstreamModels`（HTTP） | 保留 service |
| `validateProxyConfig` / `isLlmModel` | 保留 |

**configService.ts（121 行）**

| 函数 | 去向 |
|---|---|
| 底层 `SgConfig` 的 find / create / update / getAll | configManager |
| 缓存 + 默认值逻辑（`ConfigItem`、cache） | 保留 service（缓存本身就是它的 manager） |

**objectStorageService.ts（340 行）**

| 函数 | 去向 |
|---|---|
| `putToTable` / `getFromTable` / `deleteFromTable` / `deleteFromTableByPrefix` | storageManager |
| R2 适配、双位置读写的 put/get/delete 编排、位置解析、`normalizeBytes` | 保留 service |

**clientConfigService/core.ts（566 行）**

| 函数 | 去向 |
|---|---|
| `SgClientConfig` 的 13 处查询集中成 manager：`listByClient`、`findByIdAndClient`、`create`、`update`、`delete`、`disableAllByClient`、`formatUniqueName` | clientConfigManager |
| `configAdapterUtils.ts` 中的 1 处 `.query()`（随 core.ts 一起收编） | clientConfigManager |
| 文件系统适配器、`enrichStatus` 比对、`applyConfig`、`createConfig` 等 | 保留 service |

**routingService/core.ts（186 行）**

| 函数 | 去向 |
|---|---|
| `SgVendor` / `SgVendorModel` 的 find/first/create | vendorManager / vendorModelManager |
| 策略选择、候选生成 | 保留 routingService |

## 4. 建议的 manager 层结构

### 4.1 目录选择

| 方案 | 优点 | 缺点 |
|---|---|---|
| `src/manager/` 独立目录 | 层级清晰，物理隔离防止 manager 反向依赖 service | 文件数多了一级目录，import 路径变长 |
| `src/service/xxxManager.ts` 放同级 | import 短，找文件方便 | 容易混淆 service 和 manager 的职责边界 |

**结论**：采用 `src/manager/` 独立目录，与现有 MVC 惯例（`src/controller/`、`src/service/`、`src/model/`）保持对称。

### 4.2 文件列表

按「每个 model 一个 manager」建 10 个文件：

```
src/manager/
├── userManager.ts            # findById / findByToken / updateBalance
├── modelManager.ts           # get / list / hasModelsUsingVendor / listEnabled / checkDuplicate / delete / save
├── recordManager.ts          # create / update / latest / clearPayloads + payload io
├── requestActivityManager.ts # findByRecordId / updateActivities / createActivity
├── rechargeRecordManager.ts  # list / get / create
├── vendorManager.ts          # findByName / listAll / findById / update
├── vendorModelManager.ts     # listByVendor / syncByVendor / add / update / delete / getByIds  ← 收编 controller
├── configManager.ts          # get / set / getAll
├── storageManager.ts         # storage_record 表 CRUD（对象存储的 DAL 部分）
└── clientConfigManager.ts    # SgClientConfig 全量 CRUD
```

### 4.3 依赖规则

- `service → manager → model`，manager 不反向依赖 service。
- manager 之间尽量不互相调用（避免退化成第二个 service）。
- controller 的裸查询收编后，调用规则如下：
  - **纯 CRUD 接口**（如 vendorModelController 的大部分接口）：controller → manager 即可，不需要经过 service 的空壳转发。
  - **涉及业务校验的接口**（如创建前的重复检查）：应走 controller → service → manager。
- 不再允许 controller 直接碰 `Xxx.query()` 或 `ormService.dbAdapter`（statsController 的 raw SQL 也下沉到 manager）。
- `ormService` / `dbAdapter` 属于基础设施层，不属于 manager/service/controller 任一层，保持现状不动。
- 命名/导入遵循项目规范：默认导出，调用时 `模块名.方法名`。

## 5. 优先级与工作量

| 阶段 | 内容 | 改动面 | 风险 |
|---|---|---|---|
| **第一批（先做）** | rechargeRecordManager、vendorModelManager（收编 15 处裸查询） | 2 个文件，不碰核心请求链路 | 低 |
| **第二批** | modelService、recordService、userService、vendorService、requestActivityService 函数级拆分 | 触达 senderService / responseHandlerService 的依赖方（见下方依赖链） | 中，需全量测试 |
| **第三批** | configService、objectStorageService、clientConfigService | 复杂度高，收益相对低 | 中高 |
| **不建议一上来做** | statsController 的 raw SQL 重构 | — | 与前端联动，另立专项 |

第二批涉及的请求热路径依赖链：

```
senderService → userService.getUserByToken / checkBalance
responseHandlerService → recordService.attachPayload / userService.deductBalance
responseHandlerService → requestActivityService.append
```

拆分时须保持上述函数签名不变，逐条核对。

## 6. 风险与注意事项

1. **请求热路径**：`responseHandlerService` / `senderService` 调用的 `recordService`、`userService`、`requestActivityService` 拆分后须保持函数签名不变；manager 层函数名与旧 service 保持一致，service 做薄转发，避免大改调用方。
2. **事务边界**：`adjustBalance`（扣余额 + 写 recharge_record）当前是「两段 DAL 一个业务函数」，拆分后两步写操作会分到不同 manager（`userManager.updateBalance` + `rechargeRecordManager.create`），原子性风险更加显性化。建议方案：
   - **方案 A（推荐）**：拆分后在 service 层用 sutando 的事务 API 包裹两步调用，确保原子性。
   - **方案 B**：保持两步写在同一个 manager 里（但违反「manager 间不互调」原则）。
   - **方案 C**：维持现状不拆此函数的写操作，仅把查询部分（`findById`）下沉到 manager。

   > ✅ **实施结论（V1.9）**：采用**方案 C**。原因：Worker 模式下 `ormService` 已绕过 knex 连接池（`ClientD1.prototype.acquireConnection` 恒返回当前请求 D1 binding），D1 不支持多语句事务，sutando 事务 API 在 worker 模式不可靠；且原实现本身无事务、代码库也无任何 `transaction` 使用先例。原子性风险以代码注释 + 本文档显式标注，后续如需真原子性再立专项评估。
3. **测试影响**：`tests/unit/service/` 现有 8 个测试集中在无 DAL 的服务（cacheService、routingService 等），拆分破坏面不大；但新增 manager 需补测试。
4. **sutando 注意点**：`query().update()` 是裸 SQL 拼接，不走 casts（vendorService 中已有相关注释），manager 搬移时保持此行为一致。
5. **迁移策略**：建议采用「先创建 manager + 转发，再逐步修改调用方」的两步走策略，降低风险：
   - Step 1：创建 manager，service 中改为调用 manager（service 函数签名不变）
   - Step 2：确认测试全部通过后，再让 controller 直接调用 manager（跳过 service 空壳）

## 7. 实施状态（V1.9 已完成）

- [x] ~~确认 manager 层目录与命名~~ → 采用 `src/manager/` 独立目录（见 §4.1）
- [x] 第一批：rechargeRecordManager / vendorModelManager（vendorManager.findById 提前创建以收编 vendorModelController 的 vendor 校验）
- [x] 第二批：model / record / user / vendor / requestActivity 的函数级拆分
- [x] 第三批：config / objectStorage / clientConfig（normalizeBytes / toDatabaseBytes / StoredObject 随 storageManager 一并下沉）
- [x] controller 收编：vendorModel / vendor / record / recordActivity / user / model / system 的裸查询全部收编；statsController 的 raw SQL 聚合按设计另立专项，未动
- [x] 补充 manager 层集成测试：`tests/integration/manager.node.test.ts`
- [ ] eslint `no-restricted-imports`：后端无 eslint 基础设施，暂以物理目录隔离 + 代码评审保障，后续立项再补

**实施过程中的取舍**：
1. `recordService` 的 `readPayload` / `writePayload` / `attachPayload` / `clearPayloads` 保留在 service 层：它们依赖 `objectStorageService`（service 层），下沉到 manager 会违反「manager 不反向依赖 service」。
2. `configAdapterUtils.findGatewayUserByToken` 的裸查询改调 `userManager.findByToken`（而非 clientConfigManager），语义上更准确。
3. manager 层统一用 `Collection.all()` 返回纯数组（模型 builder 的 `.get()` 返回 `Collection<T>`，`.all()` 直接取底层数组），与原 Collection 返回在 JSON 序列化上等价。

## 8. 验收标准

- [ ] `src/manager/` 目录建立，10 个 manager 按 §4.2 建齐，命名/导入遵循项目规范（默认导出、`模块名.方法名`）
- [ ] 第一批：`rechargeRecordManager` / `vendorModelManager` 落地，`vendorModelController` 15 处裸查询全部收编，不再出现 controller 直接 `SgXxx.query()`
- [ ] 第二批：model / record / user / vendor / requestActivity 函数级拆分完成，热路径依赖链（`senderService`、`responseHandlerService` 相关调用）函数签名不变
- [ ] 第三批：config / objectStorage / clientConfig 拆分完成
- [ ] `adjustBalance` 两步写操作的事务原子性有明确保障（方案 A 包裹事务或按方案 C 维持）
- [ ] 全量后端测试（node + worker 模式）与 TypeScript 静态类型检查通过，前端构建通过
- [ ] `tests/unit/manager/`（或对应目录）补齐 manager 层单元测试
- [ ] 行为零回归：重构后各协议请求、计费、路由行为与重构前一致

## 9. 相关文档

- [产品文档](./step1_product.md)
- [技术文档](./step2_technical.md)
- [开发任务表](./step3_tasks.md)
