# 测试请求支持多模态（图片）输入 - 技术文档

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
    warning?: string;
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

- 同样可选、缺省 `text`；响应新增 `content_mode` 与 `warning`
- `warning` 用于说明「本次路由经过图片无法正确转换的协议方向」

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

// 供前端提示使用：判断该转换方向是否会丢图
export function isImageConversionLossy(clientFormat: ApiFormat, upstreamFormat: ApiFormat): boolean;
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
- 根据 `snapshot.client_format` / `snapshot.upstream_format` 计算 `warning`：

```ts
if (contentMode === "image" && testRequestUtil.isImageConversionLossy(client, upstream)) {
    warning = client === ApiFormat.OPENAI
        ? "当前路由需要 OpenAI → Anthropic 转换：现有转换器不会把 image_url 转成 Anthropic 的 image block，上游可能直接拒绝该请求。"
        : "当前路由需要 Anthropic → OpenAI 转换：现有转换器会丢弃图片块，模型只能看到文本提示。";
}
```

> 当前两个方向的转换器行为并不一致：`OpenAIToAnthropicConverter` 把 OpenAI content 数组原样塞给 Anthropic，图片会被上游拒绝（通常 400）；`AnthropicToOpenAIConverter` 只取 `text` 字段，图片被静默丢弃。警告文案需要区分这两种表现，否则用户会误判为"模型不支持视觉"。补齐转换器列为后续专项，不在本次范围。

### 前端改造

`frontend/src/views/Vendor/DialogTest.vue`：

- 新增 `contentMode = ref<'text' | 'image'>('text')`
- 在协议选择下方增加「请求类型」单选（复用 `a-radio-group` / `a-radio-button`），多模态时展示提示文案
- `watch(contentMode)` 清空 `result`，与现有 `watch(format)` 行为一致
- 打开对话框时重置为 `text`，避免上一次选择造成误解
- 结果摘要区在 `result.warning` 存在时渲染 `a-alert type="warning"`

`frontend/src/api/vendor.ts` / `frontend/src/api/model.ts`：

- `testVendor` 增加 `contentMode` 参数并放入请求体
- `testModelRoute` 增加 `contentMode` 参数
- `VendorTestResponse` 增加 `content_mode?: 'text' | 'image'`、`warning?: string`

## 兼容性与边界

- 所有新增字段均可选，旧前端 / 旧调用方不传时完全走文本模式，现有接口行为不变
- 内置样图由项目自行生成（纯色背景 + 几何图形），不涉及第三方素材授权
- 图片 base64 会完整出现在测试结果的「请求」Tab 中；样图 < 4KB，对前端渲染和接口响应体积影响可忽略
- 不新增数据库字段、不写配置文件、不影响计费与记录逻辑

## 测试方案

| 层级 | 用例 |
|------|------|
| 单元 | `tests/unit/util/protocol/testRequestUtil.test.ts`：3 协议 × 2 模式共 6 组请求体形状；文本模式与旧实现 JSON 等价；`isImageConversionLossy` 只对 OpenAI↔Anthropic 返回 true |
| API | `tests/api/vendor/vendor-test.test.ts`：`content_mode=image` 时上游捕获到的请求体包含图片（OpenAI / Anthropic 断言各自结构）；非法 `content_mode` 返回 400 |
| API | `tests/api/model/`：同协议多模态路由测试成功；故意路由到 OpenAI↔Anthropic 方向时返回 `warning` |
| 前端 | `DialogTest` 组件测试：切换请求类型会清空结果、调用 API 时携带 `content_mode` |

## 相关文档

- [产品文档](./step1_product.md)
- [开发任务表](./step3_tasks.md)
