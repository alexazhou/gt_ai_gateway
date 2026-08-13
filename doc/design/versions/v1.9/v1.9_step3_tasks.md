# V1.9: Service / Manager 分层重构 - 开发任务表

## 任务概览

V1.9 是规划中的版本（纯架构治理，不改业务行为）。任务按「分批推进」组织：第一批低风险先行，第二批触达请求热路径、需全量测试，第三批复杂度高、收益相对低。共 7 组任务，按依赖排序。

> 状态标记：`[x]` 已完成，`[ ]` 待完成 / 待验证。

---

## 任务列表

### 任务 1: manager 层骨架与第一批（rechargeRecord / vendorModel）

**描述**: 建立 `src/manager/` 目录与第一批 manager，收编 `vendorModelController` 15 处裸查询。

**依赖**: 无

**核心文件**:
- `src/manager/`（新建目录）
- `src/manager/rechargeRecordManager.ts`
- `src/manager/vendorModelManager.ts`
- `src/controller/vendorModelController.ts`
- `src/service/rechargeRecordService.ts`（改名）

**子任务**:
- [ ] 创建 `src/manager/` 目录，建立 10 个 manager 文件骨架
- [ ] `rechargeRecordService` 整体搬移为 `rechargeRecordManager`（`listRechargeRecords` / `getRechargeRecord`），service 薄转发
- [ ] `vendorModelManager` 建齐：`listByVendor` / `syncByVendor` / `add` / `update` / `delete` / `getByIds`
- [ ] `vendorModelController` 15 处裸查询收编，纯 CRUD 接口直接 controller → manager
- [ ] 第一批改动不触碰核心请求链路

**验收标准**:
- `vendorModelController` 无 `SgXxx.query()` 直接调用
- 第一批全量测试通过后，再进行第二批

### 任务 2: 第二批函数级拆分（model / record / user / vendor / requestActivity）

**描述**: 对五个 service 做函数级拆分，DAL 下沉到对应 manager，业务保留在 service。

**依赖**: 任务 1

**核心文件**:
- `src/service/modelService.ts`、`src/manager/modelManager.ts`
- `src/service/recordService.ts`、`src/manager/recordManager.ts`
- `src/service/userService.ts`、`src/manager/userManager.ts`
- `src/service/vendorService.ts`、`src/manager/vendorManager.ts`
- `src/service/requestActivityService.ts`、`src/manager/requestActivityManager.ts`
- 依赖方：`src/service/senderService.ts`、`responseHandlerService.ts`

**子任务**:
- [ ] `modelManager`：get / list / hasModelsUsingVendor / listEnabled / checkDuplicate / delete / save；`createModel` / `updateModel` 保留 service
- [ ] `recordManager`：create / update / latest / clearPayloads / readPayload / writePayload；`attachPayload` / `recordFailedRequest` 保留 service
- [ ] `userManager`：getUser / findById / updateBalance / createRechargeRecord；余额业务保留 service
- [ ] `vendorManager`：getVendorByName / listAll / find / update；匹配与 HTTP 逻辑保留 service
- [ ] `requestActivityManager`：findByRecordId / updateActivities / createActivity；`append` / `getByRecordId` 保留 service
- [ ] 热路径依赖链（senderService / responseHandlerService）函数签名保持不变，逐条核对
- [ ] 重构后运行全量 node + worker 模式测试与类型检查

**验收标准**:
- 热路径（`senderService` / `responseHandlerService` 调用）函数签名不变
- 各协议请求、计费、路由行为零回归

### 任务 3: 第三批（config / objectStorage / clientConfig）

**描述**: 对复杂度较高的三个 service 拆分，仅拆纯 DAL 表函数。

**依赖**: 任务 2

**核心文件**:
- `src/manager/configManager.ts`、`src/manager/storageManager.ts`、`src/manager/clientConfigManager.ts`
- `src/service/configService.ts`、`objectStorageService.ts`、`clientConfigService/core.ts`、`configAdapterUtils.ts`

**子任务**:
- [ ] `configManager`：`SgConfig` find / create / update / getAll；缓存 + 默认值保留 service
- [ ] `storageManager`：storage_record 表 CRUD；R2 适配与双位置编排保留 service
- [ ] `clientConfigManager`：`SgClientConfig` 全量 CRUD（含 `configAdapterUtils` 1 处 `.query()`）
- [ ] `routingService/core.ts` 的 `SgVendor` / `SgVendorModel` find/first/create 下沉 vendorManager / vendorModelManager

**验收标准**:
- 三个 service 中不再有直接 `.query()` 调用（表操作全部走 manager）

### 任务 4: 其余 controller 裸查询收编

**描述**: 收编 vendor / record / user / system / model controller 的裸查询。

**依赖**: 任务 2、3

**核心文件**:
- `src/controller/vendorController.ts`、`recordController.ts`、`userController.ts`、`systemController.ts`、`modelController.ts`
- `src/manager/vendorManager.ts`、`recordManager.ts`、`userManager.ts`、`modelManager.ts`

**子任务**:
- [ ] vendorController（7 处）→ vendorManager
- [ ] recordController（6 处）→ recordManager
- [ ] userController（6 处）→ userManager
- [ ] systemController（4 处）→ 对应 manager
- [ ] modelController（2 处）→ modelManager
- [ ] statsController 可下沉部分下沉到 manager（raw SQL 聚合重构与前端联动，另立专项，不在本版本）
- [ ] 全局检索确认 controller 不再直接 `SgXxx.query()` / `ormService.dbAdapter`

**验收标准**:
- 全局 grep 无 controller 直接裸查询

### 任务 5: 事务原子性

**描述**: 处理 `adjustBalance` 拆分后两步写操作的原子性。

**依赖**: 任务 2

**核心文件**:
- `src/service/userService.ts`、`src/manager/userManager.ts`、`src/manager/rechargeRecordManager.ts`

**子任务**:
- [x] 采用方案 C（保守兜底）：两步写操作仍在 service 层编排，仅查询部分（`findById`）下沉到 manager，行为与拆分前一致
- [ ] （可选，后续专项）若需真原子性，在 node 模式用 sutando 事务 API 包裹；Worker 模式 D1 不支持多语句事务（`ormService` 已绕过连接池），需另行评估
- [ ] 补充扣余额 + 写充值记录并发/异常场景测试

**验收标准**:
- 行为与拆分前一致（两步写操作非原子，与原实现相同）；原子性风险在代码注释与设计文档中显式标注

### 任务 6: manager 层单元测试

**描述**: 为新增 manager 补齐单元测试。

**依赖**: 任务 1 - 5

**核心文件**:
- `tests/unit/manager/`（新建目录或并入现有测试结构）

**子任务**:
- [ ] rechargeRecordManager / vendorModelManager 测试
- [ ] modelManager / recordManager / userManager / vendorManager / requestActivityManager 测试
- [ ] configManager / storageManager / clientConfigManager 测试
- [ ] 行为一致性断言（与拆分前 service 行为等价）

**验收标准**:
- manager 层核心读写原语有测试覆盖

### 任务 7: 依赖治理与收尾

**描述**: 检查依赖方向与 controller 收编完成度，整体回归与验收。

**依赖**: 任务 1 - 6

**核心文件**:
- `src/manager/`（依赖方向检查）
- `package.json`（版本号）

**子任务**:
- [x] controller 裸查询收编完成：全库 grep 确认 controller 无 `SgXxx.query()`（仅 statsController 的 raw SQL 聚合按设计另立专项）
- [x] manager 依赖方向检查：manager 不反向依赖 service；`vendorManager` 引用的 `ormService` 属于基础设施层（设计 §6 允许）
- [ ] （待定）eslint `no-restricted-imports` 约束：后端当前无 eslint 基础设施（仅 frontend 有），暂以 `src/manager/` 物理目录隔离 + 代码评审保障，后续立项再补
- [x] 全量回归：node 模式测试（894 通过）、TypeScript 静态类型检查、前端构建均通过
- [ ] 版本号 bump 至 v1.9（package.json / frontend / tauri 三处一致，发布时执行）

**验收标准**:
- 全量 node 测试与类型检查通过，前端构建通过
- controller 无裸查询、manager 无反向依赖 service
- 文档状态标注为已实施

---

## 总体验收

- [x] 行为零回归：各协议请求、计费、路由行为与重构前一致（node 模式全量 894 测试通过）
- [x] 全量后端测试（node 模式）通过；worker 模式留待 CI
- [x] TypeScript 静态类型检查通过
- [x] 前端构建通过
- [ ] 版本号在 package.json / frontend / tauri 三处一致（发布时执行）
