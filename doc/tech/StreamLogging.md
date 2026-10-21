# 流式日志记录说明

## 概述

系统会自动将所有流式响应（SSE）的原始内容记录到文件中，用于调试和测试。该功能由 DB 配置 `stream_log_enabled` 控制，默认关闭。

## 日志目录结构

```
log/stream/
├── {record_id}.log    # 每个请求的流式响应日志
└── ...
```

- **目录位置**：`log/stream/`（相对于项目根目录）
- **文件命名**：`{record_id}.log`，使用数据库记录的 ID 作为文件名
- **文件格式**：原始 SSE 格式，每个事件用 `\n\n` 分隔

## 日志内容格式

### Anthropic 格式

```
event: message_start
data: {"type":"message_start","message":{"type":"message","id":"xxx","role":"assistant",...}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: message_stop
data: {"type":"message_stop"}
```

### OpenAI 格式

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":12,"total_tokens":20}}

data: [DONE]
```

## 实现细节

### 代码位置

`src/service/senderService.ts` 中的 `handleStreamResponse` 函数

### 核心逻辑

1. **创建日志目录**
   ```typescript
   const logDir = join(process.cwd(), "log", "stream");
   if (!existsSync(logDir)) {
       mkdirSync(logDir, { recursive: true });
   }
   ```

2. **创建日志文件**
   ```typescript
   const logFilePath = join(logDir, `${record.id}.log`);
   ```

3. **写入流式数据**
   ```typescript
   const chunk = decoder.decode(value, { stream: true });
   writeFileSync(logFilePath, chunk, { flag: "a" });
   ```

### 特点

- **原始数据**：完整记录上游返回的原始 SSE 字节流
- **追加写入**：使用 `{ flag: "a" }` 追加模式写入，确保不覆盖已有内容
- **实时写入**：每收到一个 chunk 就立即写入文件
- **完整格式**：保留原始的 `\n\n` 分隔符，确保与实际流格式一致

## 快速开始

### 1. 启用流式日志功能

流式日志记录功能**默认不启用**，通过 DB 配置 `stream_log_enabled` 控制，仅在本地 Node 模式下可用。

#### 启用方法

方式一（推荐）：在前端管理后台「高级设置」页面打开「流式日志记录」开关并保存。

方式二：调用配置接口写入：

```bash
curl -X PUT http://localhost:8720/config.json \
  -H "Authorization: Bearer <admin_token>" \
  -H "Content-Type: application/json" \
  -d '{"stream_log_enabled":"true"}'
```

**配置说明：**
- `stream_log_enabled=true` —— 启用流式日志记录功能

> 该配置由 `configService` 管理，运行时即可切换，无需重启服务。仅本地 Node 模式下实际写入文件；Workers / 部署模式下不会写盘。

#### 检查是否启用

启动服务并发送一次流式请求后，查看控制台输出：

```
[senderService] Stream log enabled, dir: /path/to/project/log/stream
[senderService] Stream log file path: /path/to/project/log/stream/123.log
```

如果看到上述日志，说明流式日志功能已成功启用。

### 2. 启动服务

```bash
npm run backend:start
```

服务启动后，`log/stream/` 目录会在首次写入时自动创建（如果不存在）。

### 3. 发送流式请求

使用 `curl` 或其他工具发送流式请求，系统会自动记录响应内容。

#### Anthropic 格式请求

```bash
curl -X POST http://localhost:3000/api/v1/messages.json \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "x-api-key: YOUR_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "your-model-name",
    "max_tokens": 1024,
    "stream": true,
    "messages": [
      {"role": "user", "content": "Hello, what is 2+2?"}
    ]
  }'
```

#### OpenAI 格式请求

```bash
curl -X POST http://localhost:3000/api/v1/chat/completions.json \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "model": "your-model-name",
    "messages": [
      {"role": "user", "content": "Hello, what is 2+2?"}
    ],
    "stream": true
  }'
```

**重要提示**：请求必须设置 `stream: true` 才会触发流式响应记录。

### 4. 查看日志文件

请求完成后，日志文件会自动生成在 `log/stream/` 目录下：

```bash
# 查看最新生成的日志文件
ls -lt log/stream/ | head -5

# 查看特定日志文件内容
cat log/stream/123.log
```

日志文件以数据库记录的 ID 命名（如 `123.log`）。

### 5. 使用日志创建测试样本

将生成的日志文件复制到测试资源目录：

```bash
# 复制日志文件到测试资源目录
cp log/stream/123.log tests/resource/stream_logs/anthropic-stream.log

# 或者
cp log/stream/123.log tests/resource/stream_logs/openai-stream.log
```

然后在测试文件中使用：

```typescript
import { readFileSync } from "fs";
import { join } from "path";

const logFile = join(__dirname, "..", "..", "..", "resource", "stream_logs", "anthropic-stream.log");
const content = readFileSync(logFile, "utf-8");

// 按 \n\n 分割 SSE 事件
const events = content.split("\n\n");

// 处理每个事件
for (const event of events) {
    // 解析和处理事件...
}
```

## 使用场景

### 1. 调试流式响应问题

当遇到流式响应解析问题时，可以查看日志文件了解原始数据格式。

```bash
# 查看最新的流式日志
ls -lt log/stream/ | head -5

# 查看特定请求的日志
cat log/stream/{record_id}.log
```

### 2. 创建测试用例

使用实际记录的流式响应创建测试用例：

```typescript
// 将日志文件复制到测试资源目录
cp log/stream/{record_id}.log tests/resource/stream_logs/anthropic-stream.log

// 在测试中读取并验证
const content = readFileSync(logFile, "utf-8");
const events = content.split("\n\n");
// ...
```

### 3. 分析响应格式

通过日志文件可以分析不同 AI 提供商的响应格式差异。

```bash
# 查看事件类型分布
grep "^event:" log/stream/{record_id}.log | sort | uniq -c
```

## 注意事项

1. **日志保留**：日志文件不会自动清理，需要手动管理
2. **敏感信息**：日志中可能包含用户请求内容，注意保护隐私
3. **磁盘空间**：流式日志可能占用较多磁盘空间，建议定期清理
4. **性能影响**：实时写入文件会有轻微性能开销，但影响很小

## 示例

### 查看完整的流式响应

```bash
# 格式化显示 JSON
cat log/stream/123.log | jq -r '.data' | grep "^data:" | sed 's/^data: //' | jq

# 统计事件数量
grep -c "^event:" log/stream/123.log  # Anthropic
grep -c "^data:" log/stream/123.log   # OpenAI
```

### 提取特定内容

```bash
# 提取所有 content_block_delta 事件
grep "^event: content_block_delta" log/stream/123.log -A 1

# 提取最终的 usage 信息
grep "usage" log/stream/123.log
```

## 相关文件

- `src/service/senderService.ts` - 流式响应处理和日志记录
- `tests/resource/stream_logs/anthropic-stream.log` - Anthropic 格式测试示例
- `tests/resource/stream_logs/openai-stream.log` - OpenAI 格式测试示例
- `tests/unit/util/accumulator/openaiChatAccumulator.test.ts` / `anthropicAccumulator.test.ts` - 流式累加器测试用例
