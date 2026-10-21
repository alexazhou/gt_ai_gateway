# 测试请求支持多模态（图片）输入 - 开发任务表

> **状态更新（2026-10-21）**：OpenAI ↔ Anthropic 图片转换已补齐，任务中的丢图判定与 `warning` 实现项已失效，跨协议场景按普通图片转换验证即可。

## 任务概览

共 4 组开发任务，按依赖排序。前端任务依赖后端接口契约定稿，其余可并行。

> 状态标记：`[x]` 已完成，`[ ]` 待完成。

---

## 任务列表

### 任务 1: 共享测试请求构造器

**描述**: 抽取两个测试入口的请求体构造逻辑，新增图片模式。

**依赖**: 无

**核心文件**:
- `src/util/protocol/testRequestUtil.ts`（新增）
- `tests/unit/util/protocol/testRequestUtil.test.ts`（新增）

**子任务**:
- [ ] 内嵌 64×64 PNG 样图（< 4KB，base64 常量）与提示词、媒体类型常量
- [ ] `buildVendorTestBody`：文本模式与 `vendorTestService.buildRequest` 现有输出等价；图片模式按三种协议构造
- [ ] `buildModelRouteTestBody`：文本模式与 `modelController.buildTestRequestBody` 现有输出等价；图片模式按三种协议构造
- [ ] 图片模式 token 上限：供应商测试 64，模型路由测试 256
- [ ] 单元测试覆盖 3 协议 × 2 模式，以及文本模式回归

**验收标准**:
- 不传 `content_mode` 时，两种入口生成的请求体与改动前逐字段一致
- 三种协议的图片请求体结构符合协议规范（见技术文档）

---

### 任务 2: 供应商连通性测试支持多模态

**描述**: 让 `POST /vendor/:id/test.json` 接受 `content_mode`，并返回实际使用的模式。

**依赖**: 任务 1

**核心文件**:
- `src/controller/vendorController.ts`
- `src/service/vendorTestService.ts`
- `tests/api/vendor/vendor-test.test.ts`

**子任务**:
- [ ] `TestVendorOptions` 增加 `content_mode`，`buildRequest` 拆分出 `buildHeaders`
- [ ] `testVendor` 读取并校验 `content_mode`，非法值返回 400
- [ ] 结果补 `content_mode`
- [ ] API 用例：OpenAI / Anthropic 图片模式，通过 `upstreamCaptureHelper` 断言上游收到的图片结构
- [ ] API 用例：非法 `content_mode` 返回 400

**验收标准**:
- 图片模式下上游捕获到的请求体包含图片内容，文本模式请求体不变
- `auto_convert` 打开时图片仍能按最终上游协议正确构造

---

### 任务 3: 模型可用性测试支持多模态

**描述**: 让 `POST /model/route-test.json` 接受 `content_mode`，支持同协议与跨协议的多模态路由测试。

**依赖**: 任务 1

**核心文件**:
- `src/controller/modelController.ts`
- `tests/api/model/`（新增或用例补充）

**子任务**:
- [ ] 删除本地 `buildTestRequestBody`，改用 `testRequestUtil.buildModelRouteTestBody`
- [ ] 读取并校验 `content_mode`
- [ ] 成功 / 异常分支的响应补 `content_mode`
- [ ] API 用例：同协议图片模式路由测试成功，上游捕获到图片
- [ ] API 用例：跨协议（含 OpenAI ↔ Anthropic）图片模式路由测试成功，上游捕获到转换后的图片

**验收标准**:
- 三种客户端格式的多模态测试在相同协议与跨协议路由下均能走通
- 图片经协议转换后仍能到达上游，而不是被丢弃或导致上游报错

---

### 任务 4: 前端测试对话框切换

**描述**: 在两个测试入口的对话框中加入请求类型切换，并展示多模态提示与转换警告。

**依赖**: 任务 2、任务 3（接口契约）

**核心文件**:
- `frontend/src/views/Vendor/DialogTest.vue`
- `frontend/src/api/vendor.ts`
- `frontend/src/api/model.ts`
- `frontend/src/views/Vendor/DialogTest.test.ts`（新增，若现有测试结构支持）

**子任务**:
- [ ] 新增「请求类型」单选：文本 / 多模态（图片）
- [ ] 多模态模式展示提示文案，说明将发送内置图片
- [ ] 切换类型清空测试结果；打开对话框时重置为文本
- [ ] `testVendor` / `testModelRoute` 携带 `content_mode`
- [ ] `VendorTestResponse` 补 `content_mode` 类型
- [ ] 组件测试：切换类型清空结果、请求参数正确

**验收标准**:
- 两个对话框均可切换并发出对应请求
- 跨协议路由时图片仍能正确转发，请求详情 Tab 能看到图片内容

---

## 收尾验证

- [ ] `npm run backend:test`（Node 模式）全部通过
- [ ] `npm run backend:test:type` 无类型错误
- [ ] `npm run frontend:build` 构建通过
- [ ] 手工验证：三协议同协议图片测试、一次跨协议图片测试、一次文本模式回归

## 后续专项（不在本次范围）

- 本地上传图片 / 图片 URL 输入
- 音频、文件等其他模态

## 已完成的前置专项

- [x] 补齐 `OpenAIToAnthropicConverter` / `AnthropicToOpenAIConverter` 的图片内容转换
- [x] 补齐 `tool_result` / `function_call_output` 中的图片转换
