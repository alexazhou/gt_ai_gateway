> 📋 规划中：重构分析，尚未实施。

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
| requestActivityService.ts | 4 | ~90% | 整体搬走 |
| recordService.ts | 4 | ~65% | 函数级拆分 |
| configService.ts | 4 | ~25% | 只拆底层 DB 操作 |
| routingService/core.ts | 2 | ~15% | 查找下沉 |
| rechargeRecordService.ts | 2 | ~100% | 整体搬走 |
| configAdapterUtils.ts | 1 | 少量 | 随 clientConfig 一起 |

其余 service（senderService、responseHandlerService、vendorTestService、streamLogService、updateService、cacheService、upstreamHealthService、pluginService、hostService、llmRequestService）**无直接 DAL**，是纯编排/工具，无需改动。

### 2.2 controller 层裸查询分布

| Controller | 裸查询数 | 说明 |
|---|---|---|
| vendorModelController | 15 | 全是对 `SgVendorModel`/`SgVendor` 的 CRUD，**连 service 都没有**，最该先收编 |
| recordController | 8 | `SgRecord` 查询 |
| userController | 7 | `SgUser` 查询 |
| vendorController | 8 | `SgVendor` 查询 |
| statsController | 4 | 含 raw SQL（`ormService.dbAdapter.prepare`） |
| systemController | 4 | 各类查询 |
| modelController | 3 | `SgModel` 查询 |
| balanceController | 1 | 少量 |

## 3. 逐 Service 拆分清单

### 3.1 整体搬走（纯 DAL）

**rechargeRecordService.ts（39 行）**

| 函数 | 去向 |
|---|---|
| `listRechargeRecords` | rechargeRecordManager |
| `getRechargeRecord` | rechargeRecordManager |

100% 纯 DAL，整个文件可直接改名 `rechargeRecordManager`。

**requestActivityService.ts（81 行）**

| 函数 | 去向 |
|---|---|
| `append`（upsert by record_id） | requestActivityManager |
| `getByRecordId` | requestActivityManager |

~90%，仅剩 best-effort 容错这层极薄的「业务」。

### 3.2 函数级拆分（业务 + DAL 混合）

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
| 文件系统适配器、`enrichStatus` 比对、`applyConfig`、`createConfig` 等 | 保留 service |

**routingService/core.ts（186 行）**

| 函数 | 去向 |
|---|---|
| `SgVendor` / `SgVendorModel` 的 find/first/create | vendorManager / vendorModelManager |
| 策略选择、候选生成 | 保留 routingService |

## 4. 建议的 manager 层结构

按「每个 model 一个 manager」建 10 个文件：

```
src/manager/
├── userManager.ts            # findById / findByToken / updateBalance / createRechargeRecord
├── modelManager.ts           # get / list / hasModelsUsingVendor / listEnabled / checkDuplicate / delete / save
├── recordManager.ts          # create / update / latest / clearPayloads + payload io
├── requestActivityManager.ts # upsert / getByRecordId
├── rechargeRecordManager.ts  # list / get
├── vendorManager.ts          # findByName / listAll / findById / update
├── vendorModelManager.ts     # listByVendor / syncByVendor / add / update / delete / getByIds  ← 收编 controller
├── configManager.ts          # get / set / getAll
├── storageManager.ts         # storage_record 表 CRUD（对象存储的 DAL 部分）
└── clientConfigManager.ts    # SgClientConfig 全量 CRUD
```

**依赖规则**：

- `service → manager → model`，manager 不反向依赖 service。
- manager 之间尽量不互相调用（避免退化成第二个 service）。
- controller 只调 service，不再直接碰 `Xxx.query()` 或 `ormService.dbAdapter`（statsController 的 raw SQL 也下沉到 manager）。
- 命名/导入遵循项目规范：默认导出，调用时 `模块名.方法名`。

## 5. 优先级与工作量

| 阶段 | 内容 | 改动面 | 风险 |
|---|---|---|---|
| **第一批（先做）** | rechargeRecordManager、requestActivityManager、vendorModelManager（收编 15 处裸查询） | 3 个文件，不碰核心请求链路 | 低 |
| **第二批** | modelService、recordService、userService、vendorService 函数级拆分 | 触达 senderService / responseHandlerService 的依赖方 | 中，需全量测试 |
| **第三批** | configService、objectStorageService、clientConfigService | 复杂度高，收益相对低 | 中高 |
| **不建议一上来做** | statsController 的 raw SQL 重构 | — | 与前端联动，另立专项 |

## 6. 风险与注意事项

1. **请求热路径**：`responseHandlerService` / `senderService` 调用的 `recordService`、`userService`、`requestActivityService` 拆分后须保持函数签名不变；manager 层函数名与旧 service 保持一致，service 做薄转发，避免大改调用方。
2. **事务边界**：`adjustBalance`（扣余额 + 写 recharge_record）当前是「两段 DAL 一个业务函数」，拆分后要保证业务层的顺序/原子性语义不变。
3. **测试影响**：`tests/unit/service/` 现有 8 个测试集中在无 DAL 的服务（cacheService、routingService 等），拆分破坏面不大；但新增 manager 需补测试。
4. **sutando 注意点**：`query().update()` 是裸 SQL 拼接，不走 casts（vendorService 中已有相关注释），manager 搬移时保持此行为一致。

## 7. 后续 TODO

- [ ] 确认 manager 层目录与命名（`src/manager/` vs `src/service/xxxManager`）
- [ ] 第一批：rechargeRecordManager / requestActivityManager / vendorModelManager
- [ ] 第二批：model / record / user / vendor 的函数级拆分
- [ ] 第三批：config / objectStorage / clientConfig
- [ ] controller 收编统计与核对
- [ ] 补充 manager 层单元测试
