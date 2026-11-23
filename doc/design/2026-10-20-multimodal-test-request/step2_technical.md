# 测试请求支持多模态（图片）输入 - 技术文档

> ## ✅ 实施状态（2026-11-16，任务单 #285）
>
> **本文档描述的功能已落地**：实现依据以实施报告 `shared/multimodal-test-request/report.md` 为准；
> 本文与本实现的差异、以及文中**已失效的前提**，见紧随本节之后的「#285 落地对照」。
>
> **正文保持 2026-10-20 原样不改** —— 它是当时的判断记录；改正文会让后来人分不清
> 「当初没想到」和「想到了但写错」。过时的前提集中标注在下面这一节，不散落在正文里。

> **状态更新（2026-10-21）**：OpenAI ↔ Anthropic 图片转换已补齐，`isImageConversionLossy` 与 `warning` 相关设计不再需要。实现本功能时，模型路由测试可以直接发送跨协议图片请求，其余设计不变。

## 架构概览

改动集中在「测试请求构造」这一层，不触碰真实转发链路（`senderService` / `responseHandlerService`）：

```text
前端 DialogTest.vue
  │  content_mode: "text" | "image"
  ├── POST /vendor/:id/test.json ──→ vendorController → vendorTestService ─┐
  └── POST /model/route-test.json ─→ modelController ──────────────────────┤
                                                                           ▼
                                              util/protocol/testRequestUtil
                                              （按 OpenAI / Anthropic / Responses
                                                构造文本或多模态请求体）
```

- 两个入口原本各自内联构造请求体（`vendorTestService.buildRequest`、`modelController.buildTestRequestBody`），本次抽取为共享工具，避免三套协议逻辑再复制一遍
- 图片与提示词由后端内置，前端只传 `content_mode`，不传输图片数据
- 模型路由测试仍走既有 `senderService.sendRequest({ inspect: true })`，协议转换、路由、快照逻辑不变

## 接口定义

### 供应商连通性测试

`POST /vendor/:id/test.json`

```json
{
  "format": "openai",
  "model": "gpt-4o-mini",
  "auto_convert": false,
  "content_mode": "image"
}
```

- `content_mode` 可选，缺省 `text`；非法值返回 400
- 响应在现有 `TestVendorResult` 基础上新增：

```ts
interface TestVendorResult {
    // ...existing fields
    content_mode: "text" | "image";
}
```

### 模型可用性测试

`POST /model/route-test.json`

```json
{
  "model": "gpt-4o",
  "format": "openai",
  "content_mode": "image"
}
```

- 同样可选、缺省 `text`；响应新增 `content_mode`
- 跨协议图片转换已支持，不再需要 `warning` 字段

## 核心模块

### 共享请求构造器

新增 `src/util/protocol/testRequestUtil.ts`：

```ts
export type TestContentMode = "text" | "image";

export const TEST_IMAGE_PROMPT = "请描述这张图片";
export const TEST_IMAGE_MEDIA_TYPE = "image/png";
const TEST_IMAGE_BASE64 = "...";  // 64×64 PNG，< 4KB

// 两个入口的文本提示词与 token 上限保持现状
export function buildVendorTestBody(format: ApiFormat, model: string, mode: TestContentMode): string;
export function buildModelRouteTestBody(format: ApiFormat, model: string, mode: TestContentMode): string;
```

内部按协议分支，文本模式产出的 JSON 与现有实现逐字段等价（回归用例钉住）：

| 调用方 | 文本提示词 | 文本模式 token 上限 | 图片模式 token 上限 |
|--------|-----------|--------------------|---------------------|
| 供应商测试 | `ping` | OpenAI 5 / Anthropic 1 / Responses 16 | 统一 64 |
| 模型路由测试 | `你好` | 256 | 统一 256 |

> 图片模式必须放宽 `max_tokens`：Anthropic 文本模式只用 1 个 token，视觉问答会被直接截断，无法验证图片是否真的被接收。

### 多模态请求体

以下示例的 token 上限以供应商测试（64）为例；模型路由测试用 256，字段结构相同。

**OpenAI Chat Completions**

```json
{
  "model": "<model>",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "请描述这张图片" },
      { "type": "image_url", "image_url": { "url": "data:image/png;base64,<SAMPLE>" } }
    ]
  }],
  "max_tokens": 64,
  "stream": false
}
```

**Anthropic Messages**

```json
{
  "model": "<model>",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "<SAMPLE>" } },
      { "type": "text", "text": "请描述这张图片" }
    ]
  }],
  "max_tokens": 64
}
```

**OpenAI Responses**

```json
{
  "model": "<model>",
  "input": [{
    "role": "user",
    "content": [
      { "type": "input_text", "text": "请描述这张图片" },
      { "type": "input_image", "image_url": "data:image/png;base64,<SAMPLE>" }
    ]
  }],
  "max_output_tokens": 64
}
```

要点：

- 图片一律用 `data:` URL / base64 内联，不引入外部 URL
- 各协议内图片与文本的顺序按各自文档推荐排列（Anthropic 图片在前，OpenAI / Responses 文本在前），两种顺序通常都接受，按推荐写法减少兼容性差异
- Responses 的 `input_image.image_url` 是字符串，不是 OpenAI 的 `{ url }` 对象，两者不要混用
- `stream: false` 仅模型路由测试保留（沿现有实现）；供应商测试不带该字段

### 供应商测试改造

`vendorTestService.ts`：

- `TestVendorOptions` 增加 `content_mode?: TestContentMode`
- `buildRequest` 拆成 `buildHeaders`（保留现有鉴权头逻辑）+ `testRequestUtil.buildVendorTestBody`
- 注意 `auto_convert` 的行为不变：先解析出 `requestFormat`，再**直接按该格式原生构造**请求体，因此多模态在 auto_convert 下不会被协议转换丢掉
- 返回结果补 `content_mode`

`vendorController.testVendor` 读取并校验 `bodyJson.content_mode`，非法值抛 `AppError`（400）。

### 模型路由测试改造

`modelController.testModelRoute`：

- 读取 `content_mode`，用 `testRequestUtil.buildModelRouteTestBody(format, modelName, mode)` 替换本地 `buildTestRequestBody`
- 删除 `modelController.ts` 顶部的 `buildTestRequestBody`
- 成功分支与异常分支共用同一套快照解析，在结果中补 `content_mode`
- 跨协议图片转换已支持，结果中不再需要 `warning` 字段

### 前端改造

`frontend/src/views/Vendor/DialogTest.vue`：

- 新增 `contentMode = ref<'text' | 'image'>('text')`
- 在协议选择下方增加「请求类型」单选（复用 `a-radio-group` / `a-radio-button`），多模态时展示提示文案
- `watch(contentMode)` 清空 `result`，与现有 `watch(format)` 行为一致
- 打开对话框时重置为 `text`，避免上一次选择造成误解

`frontend/src/api/vendor.ts` / `frontend/src/api/model.ts`：

- `testVendor` 增加 `contentMode` 参数并放入请求体
- `testModelRoute` 增加 `contentMode` 参数
- `VendorTestResponse` 增加 `content_mode?: 'text' | 'image'`

## 兼容性与边界

- 所有新增字段均可选，旧前端 / 旧调用方不传时完全走文本模式，现有接口行为不变
- 内置样图由项目自行生成（纯色背景 + 几何图形），不涉及第三方素材授权
- 图片 base64 会完整出现在测试结果的「请求」Tab 中；样图 < 4KB，对前端渲染和接口响应体积影响可忽略
- 不新增数据库字段、不写配置文件、不影响计费与记录逻辑

## 测试方案

| 层级 | 用例 |
|------|------|
| 单元 | `tests/unit/util/protocol/testRequestUtil.test.ts`：3 协议 × 2 模式共 6 组请求体形状；文本模式与旧实现 JSON 等价 |
| API | `tests/api/vendor/vendor-test.test.ts`：`content_mode=image` 时上游捕获到的请求体包含图片（OpenAI / Anthropic 断言各自结构）；非法 `content_mode` 返回 400 |
| API | `tests/api/model/`：同协议与跨协议多模态路由测试成功 |
| 前端 | `DialogTest` 组件测试：切换请求类型会清空结果、调用 API 时携带 `content_mode` |


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

## 相关文档

- [产品文档](./step1_product.md)
- [开发任务表](./step3_tasks.md)
