# V1.3: 流式记录与仪表盘 - 产品文档

## 目标

补齐请求的可观测性：流式响应被正确记录、请求有日志、仪表盘能直观展示系统运行状况，并提供集成配置页方便对接。

## 功能特性

- **流式响应记录**：SSE 累加器对流式消息累加，非流式响应同样落库
- **请求日志**：`RECORD_LOG_ENABLED` 环境变量控制请求日志输出，便于排查
- **流式日志（stream log）**：Node 模式下可选将流式 chunk 写入本地日志文件，仅通过环境变量启用
- **仪表盘**：请求总数 / 成功率 / 活跃用户与模型统计卡片、请求 token 与耗时展示
- **集成页**：展示 OpenAI / Anthropic 端点 URL 的集成配置说明页
- **请求记录增强**：记录 token / 耗时，前端输入输出 token 箭头标识
- **性能**：前端 bundle 优化（tree-shaking、按需加载），Docker 构建深度优化
- **工程化**：CI 升级 Node 22、发布流程文档、日志目录统一

## 管理 / 监控 API 接口一览

| 模块 | 方法 | 路径 | 说明 |
|---|---|---|---|
| 请求记录 | GET | `/record/list.json` | 记录列表（按状态 / 用户名 / 模型名 / 时间范围筛选，分页） |
| 请求记录 | GET | `/record/latest.json` | 最近记录 |
| 请求记录 | GET | `/record/:id` | 记录详情（含请求 / 响应数据） |
| 统计 | GET | `/stats/dashboard.json` | 仪表盘统计（今日请求 / 成功率 / 活跃用户 / 活跃模型） |
| 统计 | GET | `/stats/recent.json` | 最近记录 |
| LLM | POST | `/v1/chat/completions` | OpenAI 格式聊天接口 |
| LLM | POST | `/v1/messages` | Anthropic 格式消息接口 |

## 前端功能模块

- **请求记录**：记录列表（ID / 用户 / 供应商 / 模型 / 状态 / 时间）、按状态与时间范围筛选、请求 / 响应 JSON 详情展示（可折叠、可复制）
- **仪表盘增强**：统计卡片（今日请求总数 / 成功率 / 活跃用户 / 活跃模型）、最近请求快捷入口、自动刷新（30 秒）与控制按钮
- **API 测试工具**：API 格式选择（OpenAI / Anthropic）、模型选择、多轮消息输入、参数配置（temperature / max_tokens 等）、流式响应展示、历史记录

## 验收标准

- [ ] 流式请求完成后，record 中能查到完整响应内容与 token 统计
- [ ] 开启 RECORD_LOG_ENABLED 后请求日志可见
- [ ] 仪表盘统计与请求记录列表数据准确

## 相关文档

- 专项设计：[request_record_and_activity_design.md](../2026-07-04-multi-upstream-object-storage-billing/request_record_and_activity_design.md)
