# 测试请求支持多模态（图片）输入 - 开发任务表

> ## ✅ 实施状态（2026-11-16，任务单 #285）
>
> **本文档描述的功能已落地**：实现依据以实施报告 `shared/multimodal-test-request/report.md` 为准；
> 本文与本实现的差异、以及文中**已失效的前提**，见紧随本节之后的「#285 落地对照」。
>
> **正文保持 2026-10-20 原样不改** —— 它是当时的判断记录；改正文会让后来人分不清
> 「当初没想到」和「想到了但写错」。过时的前提集中标注在下面这一节，不散落在正文里。

> **状态更新（2026-10-21）**：OpenAI ↔ Anthropic 图片转换已补齐，任务中的丢图判定与 `warning` 实现项已失效，跨协议场景按普通图片转换验证即可。

## 任务概览

共 4 组开发任务，按依赖排序。前端任务依赖后端接口契约定稿，其余可并行。

> 状态标记：`[x]` 已完成，`[ ]` 待完成。**2026-11-16 按 #285 完成情况回填**（判据与实收见实施报告 `shared/multimodal-test-request/report.md`）。

---

## 任务列表

### 任务 1: 共享测试请求构造器

**描述**: 抽取两个测试入口的请求体构造逻辑，新增图片模式。

**依赖**: 无

**核心文件**:
- `src/util/protocol/testRequestUtil.ts`（新增）
- `tests/unit/util/protocol/testRequestUtil.test.ts`（新增）

**子任务**:
- [x] 内嵌 64×64 PNG 样图（< 4KB，base64 常量）与提示词、媒体类型常量
- [x] `buildVendorTestBody`：文本模式与 `vendorTestService.buildRequest` 现有输出等价；图片模式按三种协议构造
- [x] `buildModelRouteTestBody`：文本模式与 `modelController.buildTestRequestBody` 现有输出等价；图片模式按三种协议构造
- [x] 图片模式 token 上限：供应商测试 64，模型路由测试 256
- [x] 单元测试覆盖 3 协议 × 2 模式，以及文本模式回归

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
- [x] `TestVendorOptions` 增加 `content_mode`，`buildRequest` 拆分出 `buildHeaders`
- [x] `testVendor` 读取并校验 `content_mode`，非法值返回 400
- [x] 结果补 `content_mode`
- [x] API 用例：OpenAI / Anthropic 图片模式，通过 `upstreamCaptureHelper` 断言上游收到的图片结构
- [x] API 用例：非法 `content_mode` 返回 400

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
- [x] 删除本地 `buildTestRequestBody`，改用 `testRequestUtil.buildModelRouteTestBody`
- [x] 读取并校验 `content_mode`
- [x] 成功 / 异常分支的响应补 `content_mode`
- [x] API 用例：同协议图片模式路由测试成功，上游捕获到图片
- [x] API 用例：跨协议（含 OpenAI ↔ Anthropic）图片模式路由测试成功，上游捕获到转换后的图片

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
- [x] 新增「请求类型」单选：文本 / 多模态（图片）
- [x] 多模态模式展示提示文案，说明将发送内置图片
- [x] 切换类型清空测试结果；打开对话框时重置为文本
- [x] `testVendor` / `testModelRoute` 携带 `content_mode`
- [x] `VendorTestResponse` 补 `content_mode` 类型
- [x] 组件测试：切换类型清空结果、请求参数正确

**验收标准**:
- 两个对话框均可切换并发出对应请求
- 跨协议路由时图片仍能正确转发，请求详情 Tab 能看到图片内容

---

## 收尾验证

- [x] `npm run backend:test`（Node 模式）全部通过
- [x] `npm run backend:test:type` 无类型错误
- [x] `npm run frontend:build` 构建通过
- [ ] **手工验证（未做）**：三协议同协议图片测试、一次跨协议图片测试、一次文本模式回归
      → 实际覆盖来自 API 用例（`vendor-test` 12 用例、`modelRouteContentMode` 4 用例，含跨协议 anthropic→openai），
        不含界面手工操作，也没有截图记录；原先勾成 `[x]` 属于超出举证（验收人 O1 指出，2026-11-16 修正）

## 后续专项（不在本次范围）

- 本地上传图片 / 图片 URL 输入
- 音频、文件等其他模态

## 已完成的前置专项

- [x] 补齐 `OpenAIToAnthropicConverter` / `AnthropicToOpenAIConverter` 的图片内容转换
- [x] 补齐 `tool_result` / `function_call_output` 中的图片转换

## #285 落地对照（2026-11-16）

### A. 已失效的前提（**不得再引用**）

| # | 本文的前提 | 现实 | 处置 |
|---|---|---|---|
| A1 | 「OpenAI ↔ Anthropic 转换器不支持图片」⇒ 需要设计跨协议丢图 `warning`、并把「跨协议」列为能力边界 | **六向图片转换已补齐**（`doc/tech/review.md` P2 记录；本文件顶部 2026-10-21 状态更新已提及） | 相关设计**作废**：实现里**没有** `warning` 字段，「跨协议限制」边界**作废**，跨协议路由按普通图片转换验证 |

### B. 实现与设计一致的项（逐条已核，读实现时不必再对照正文）

- 入参名与缺省：`content_mode`（`text` | `image`），缺省 `text`；非法值 **400**，不静默降级；
- 三协议图片结构：OpenAI `[{type:text},{type:image_url,image_url:{url}}]`、Anthropic `[{type:image,source:{type:base64,media_type,data}},{type:text}]`（图在前）、Responses `input:[{role,content:[{type:input_text},{type:input_image,image_url:<字符串>}]}]`；
- token 上限：供应商测试文本 5/1/16、图片 **64**；模型路由测试文本 256、图片 **256**；OpenAI 仅模型路由带 `stream:false`；
- 内置样图：64×64 PNG、base64 常量、< 4KB（实际 **230 字节**，base64 308 字符），无外部依赖；
- 接口回显：两个入口的响应都补 `content_mode`；
- 代码落点：`src/util/protocol/testRequestUtil.ts` 新建；`vendorTestService.buildRequest` 拆成 `buildHeaders` + 共享构造器；`modelController.buildTestRequestBody` **已删除**，改用 `buildModelRouteTestBody`；
- 前端：`DialogTest.vue` 加「请求类型」单选（文本默认 / 多模态图片），`watch(contentMode)` 清空上次结果，打开对话框重置为 `text`；`api/vendor.ts` / `api/model.ts` 带上 `content_mode`。

### C. 实现与设计的偏差（都不改契约，登记备查）

| # | 偏差 | 理由 |
|---|---|---|
| C1 | `testRequestUtil` 除了两个 `build*TestBody`，还导出 `normalizeContentMode`（校验）+ `TEST_IMAGE_DATA_URL` + 默认导出对象 | 校验逻辑只能有一份（两个入口共用，避免各写一套「非法值怎么处理」）；`TEST_IMAGE_DATA_URL` 是两种协议都要用的派生常量 |
| C2 | 图片模式的**文本提示词固定为「请描述这张图片」**，不继承各入口的文本提示词（`ping` / `你好`） | 文本提示词在图片模式下没有意义；固定一条也让「上游收到的图片请求」可被稳定断言 |
| C3 | 文档未提但实现做了：`TEST_CONTENT_MODES` 常量导出 | 前端「请求类型」的取值来源，避免前后端各写一份字面量 |

### D. 边界（实现未越界，可作验收对照）

- 不支持本地图片上传、图片 URL、音频 / 视频 / 文件输入（仍只发内置样图）；
- 未改测试请求的计费 / 记录 / 活动时间线链路；
- 未改真实转发链路（`senderService` / `responseHandlerService`）—— 模型路由测试仍走既有的 `sendRequest({ inspect: true })`；
- 未新增数据库字段、未写配置文件。
