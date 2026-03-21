# 前端改造点清单

## 背景

当前前端功能已经可用，但基础层仍保留了明显的快速迭代痕迹：

- 请求层存在双轨实现，REST 和流式请求没有统一治理
- 列表页大量依赖前端持有全量数据，再在页面侧做分页和统计
- 公共 composable 和组件中存在较多弱类型定义
- 自动刷新能力缺少并发保护和取消语义
- 前端缺少稳定的质量门禁，很多问题只能依赖人工发现

这些问题短期不会让系统不可用，但会持续提高后续需求开发、回归验证和线上排障成本。

## 范围说明

本文只记录当前建议执行的前端改造项。

明确排除：

- 路由懒加载

排除原因：

- 当前项目更重视一次性加载后的后台切换体验
- 因此前端路由继续保留静态导入，不作为本轮改造目标

## 目标

本轮改造的目标不是重写前端，而是补齐几个关键基础层能力：

- 让请求行为、错误处理和鉴权行为一致
- 让列表和统计查询具备可扩展性
- 让自动刷新具备稳定的串行执行语义
- 让类型系统开始承担约束作用，而不是仅用于通过编译
- 让常见低级问题在提交前就被工具拦住

## 现状问题

### 1. 请求层没有统一收口

普通 REST 请求走 `axios` 拦截器：

- [frontend/src/utils/request.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/frontend/src/utils/request.ts)

但 API 测试页又单独使用 `fetch` 和 `fetchEventSource` 手写 token、错误处理和流式解析：

- [frontend/src/api/gateway.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/frontend/src/api/gateway.ts)

直接结果：

- 同类错误在不同页面上的提示方式不一致
- 401、403、500 等状态码的处理规则容易分叉
- 未来若增加埋点、请求取消、trace id、统一重试，需要重复改多处

### 2. 列表和统计页面依赖全量数据

当前用户、供应商、模型列表页都是直接取列表结果后在前端维护分页状态：

- [frontend/src/views/User/List.vue](/Volumes/PDATA/GitDB/serverless_ai_gateway/frontend/src/views/User/List.vue)
- [frontend/src/views/Vendor/List.vue](/Volumes/PDATA/GitDB/serverless_ai_gateway/frontend/src/views/Vendor/List.vue)
- [frontend/src/views/Model/List.vue](/Volumes/PDATA/GitDB/serverless_ai_gateway/frontend/src/views/Model/List.vue)

仪表盘甚至通过请求完整用户、供应商、模型列表，再用 `length` 做系统统计：

- [frontend/src/views/Dashboard.vue](/Volumes/PDATA/GitDB/serverless_ai_gateway/frontend/src/views/Dashboard.vue)

直接结果：

- 数据规模增长后，页面加载成本会同步上升
- 分页只是 UI 分页，不是真正的数据分页
- 统计逻辑依赖多个业务列表接口，接口职责不清晰

### 3. 自动刷新缺少并发保护

自动刷新逻辑位于：

- [frontend/src/composables/useAutoRefresh.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/frontend/src/composables/useAutoRefresh.ts)

当前行为是：

- `start()` 先触发一次回调
- 不等待这次回调完成，就继续安排下一轮定时器

风险：

- 若单次刷新耗时过长，会出现重叠请求
- 用户手动刷新和自动刷新可能互相覆盖状态
- 页面切换后若旧请求晚返回，可能回写过期数据

### 4. 类型系统约束偏弱

当前弱类型主要集中在公共层：

- [frontend/src/types/index.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/frontend/src/types/index.ts)
- [frontend/src/composables/useTable.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/frontend/src/composables/useTable.ts)
- [frontend/src/components/common/RecordTable.vue](/Volumes/PDATA/GitDB/serverless_ai_gateway/frontend/src/components/common/RecordTable.vue)

同时 API 层也存在多个 `params?: any`、`Promise<any>`：

- [frontend/src/api/user.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/frontend/src/api/user.ts)
- [frontend/src/api/vendor.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/frontend/src/api/vendor.ts)
- [frontend/src/api/model.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/frontend/src/api/model.ts)
- [frontend/src/api/system.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/frontend/src/api/system.ts)

直接结果：

- 重构时 IDE 和 TS 无法提供足够保护
- 组件接口越来越宽，后续维护者不容易知道真实契约
- 编译能过，不代表设计是稳定的

### 5. 列表页实现模式重复

用户、供应商、模型三个页面都重复维护以下逻辑：

- 搜索表单状态
- 页面初始化加载
- 搜索重置
- 分页状态同步
- 成功后刷新列表

重复文件：

- [frontend/src/views/User/List.vue](/Volumes/PDATA/GitDB/serverless_ai_gateway/frontend/src/views/User/List.vue)
- [frontend/src/views/Vendor/List.vue](/Volumes/PDATA/GitDB/serverless_ai_gateway/frontend/src/views/Vendor/List.vue)
- [frontend/src/views/Model/List.vue](/Volumes/PDATA/GitDB/serverless_ai_gateway/frontend/src/views/Model/List.vue)

直接结果：

- 一个交互约定变更需要改三到四处
- 以后再增加更多资源页，会继续复制同一套模式
- 公共抽象存在，但粒度还不够，未真正降低重复

### 6. 认证状态和请求层存在耦合

认证状态集中在：

- [frontend/src/stores/auth.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/frontend/src/stores/auth.ts)

但 401 处理目前直接发生在请求拦截器里，且直接操作 `localStorage` 和 `window.location`：

- [frontend/src/utils/request.ts](/Volumes/PDATA/GitDB/serverless_ai_gateway/frontend/src/utils/request.ts)

直接结果：

- store 不是认证状态的唯一可信来源
- 路由跳转和鉴权清理逻辑耦合在网络层
- 未来若要支持更复杂的登录态恢复、退出登录提示或多标签页同步，会比较别扭

### 7. 缺少前端质量门禁

当前前端脚本只有：

- `dev`
- `build`
- `preview`

见：

- [frontend/package.json](/Volumes/PDATA/GitDB/serverless_ai_gateway/frontend/package.json)

当前缺少：

- `lint`
- 基础测试脚本
- 针对关键交互的最小自动化验证

直接结果：

- 未使用变量、弱类型扩散、重复代码等问题不容易在提交前暴露
- 页面改动后更依赖人工点一遍

## 改造项

### A. 统一请求层

目标：

- 统一 token 注入、错误对象格式、鉴权失效处理、请求日志上下文
- REST 和流式请求共用一套请求基础设施

建议动作：

- 抽出统一的请求上下文读取能力，不在各处直接读 `localStorage`
- 给 `request.ts` 定义统一错误模型，例如 `AppRequestError`
- 将 `api/gateway.ts` 中公共的错误解析、token 注入逻辑下沉到共享层
- 约束 UI 提示只在页面层或特定 action 层触发，请求工具层不直接弹全局提示

预期收益：

- 错误行为一致
- 后续接入取消请求、埋点、trace id 更容易
- 减少 API 测试页面与普通管理页面的行为漂移

### B. 改为服务端分页和聚合统计

目标：

- 列表页不再依赖全量数据
- 仪表盘不再通过多个业务列表接口做统计拼装

建议动作：

- 为用户、供应商、模型列表接口补统一分页返回结构
- 前端列表页统一消费 `list + total + page + pageSize`
- 为仪表盘补聚合接口，直接返回系统总量与核心统计值
- 明确“列表接口”和“统计接口”的职责边界

预期收益：

- 数据量增长后页面性能更稳定
- 前后端分页语义一致
- 仪表盘逻辑更清晰，减少多接口拼装耦合

### C. 重构自动刷新机制

目标：

- 自动刷新在任何页面都保证串行执行
- 停止刷新或切页后，不再允许旧请求污染页面状态

建议动作：

- `useAutoRefresh` 增加执行中标记，未完成前不启动下一轮
- 支持请求级取消或结果过期保护
- 明确“手动刷新”和“自动刷新”的协作规则
- 对统计页、记录页先完成接入验证

预期收益：

- 降低状态抖动
- 降低重复请求
- 更容易定位页面刷新相关问题

### D. 加强类型约束

目标：

- 先修公共层和 API 层，再逐步向页面层扩散

建议动作：

- 替换 `BaseResponse<T = any>` 这类过宽定义
- 为 `useTable` 增加查询参数、表格分页、返回结果的泛型约束
- 为 `RecordTable`、列表页列定义和分页事件补上明确类型
- 清理 API 层中的 `params?: any`、`Promise<any>`
- 对流式返回块和系统状态接口补充明确类型

预期收益：

- 重构安全性提升
- 公共组件更可预测
- 后续需求开发时更容易发现接口契约问题

### E. 抽取统一列表页模式

目标：

- 统一资源列表页的开发方式，减少重复实现

建议动作：

- 基于当前 `useTable` 升级出更完整的列表页 composable
- 统一搜索、重置、分页切换、加载中和刷新逻辑
- 提炼通用列定义辅助方法或基础表格容器
- 优先覆盖用户、供应商、模型页面

预期收益：

- 新增资源页时开发成本更低
- 交互一致性更好
- 减少重复修 bug 的成本

### F. 调整认证边界

目标：

- 让认证状态只由 store 驱动，请求层只负责上报认证失败

建议动作：

- 将 401 后的清理逻辑收回到 auth store 或统一 auth action
- 请求层返回标准化的鉴权失败错误
- 路由守卫和登录页只依赖 store 状态，不直接依赖浏览器存储
- 视情况补充多标签页 token 变化同步

预期收益：

- 认证链路更清晰
- 跳转与清理行为更可控
- 后续支持更复杂登录态策略时改动面更小

### G. 补齐质量门禁

目标：

- 让明显低级问题在开发阶段就被拦住

建议动作：

- 增加 ESLint，并启用 TypeScript 与 Vue 规则
- 对未使用变量、显式 `any`、重复导入、危险断言设置规则
- 补一个最小前端测试集，优先覆盖登录、列表筛选、自动刷新、供应商测试、记录详情
- 将 lint 和测试纳入发布前检查流程

预期收益：

- 降低人工回归负担
- 降低低级错误进入主分支的概率
- 建立稳定的前端开发基线

## 优先级建议

### 第一批

- 统一请求层
- 重构自动刷新机制
- 加强类型约束
- 补齐质量门禁

原因：

- 这几项会直接影响后续所有页面改造质量
- 属于典型基础设施问题，越晚改，扩散越大

### 第二批

- 改为服务端分页和聚合统计
- 抽取统一列表页模式
- 调整认证边界

原因：

- 依赖第一批基础层改造结果
- 涉及更多页面和前后端契约协调

## 建议实施顺序

1. 先补 ESLint 和最小测试脚本，建立质量门槛
2. 再统一请求层错误模型和认证失败处理
3. 然后重构 `useAutoRefresh`，完成统计页和记录页接入
4. 接着推进公共类型和 API 类型收口
5. 再改用户、供应商、模型、记录的服务端分页契约
6. 最后抽取统一列表页模式，并顺手整理认证边界

## 拆任务建议

为了降低改造风险，建议拆成以下独立任务：

- 任务 1：引入前端 lint 和基础测试框架
- 任务 2：统一请求层与错误模型
- 任务 3：重构自动刷新 composable
- 任务 4：清理公共层 `any` 与 API 类型
- 任务 5：用户/供应商/模型/记录分页接口改造
- 任务 6：仪表盘聚合统计接口改造
- 任务 7：统一列表页抽象
- 任务 8：认证链路整理

## 非目标

本轮不包含以下内容：

- 路由懒加载
- 视觉风格重设计
- 全量重写页面组件
- 切换 UI 框架

## 结论

当前前端最需要解决的不是单个页面的细节问题，而是基础层的一致性和扩展性。

如果以上改造完成，后续继续扩展后台页面时，收益会主要体现在：

- 新需求接入更快
- 问题定位更直接
- 页面行为更稳定
- 发布回归成本更低
