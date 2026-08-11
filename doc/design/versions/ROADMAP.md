# Serverless AI Gateway - 实施路线图

## 项目概述

一个 Serverless 的 AI API 网关，对外提供 OpenAI / Anthropic / Responses 三种协议的统一入口，负责鉴权、计费、路由、协议转换、请求记录与流式转发。可在本地 Node 模式、Cloudflare Workers（D1 + R2）以及 Tauri 桌面应用三种形态下运行。

> 说明：本文档按发布版本的前两位（如 v1.8）整理，忽略补丁版本号（第三位）。内容由各版本 git 提交记录汇总而来，按里程碑概述主要能力。

---

## 版本概览

### V1.0: 基础网关能力 (已完成)

打通「客户端 → 网关 → 上游 LLM」的最简链路，建立核心数据模型：

- **OpenAI API 网关**：提供 Chat Completions 端点，转发上游请求
- **SSE 流式转发**：服务端 SSE、请求 SSE、流式响应中继、失败消息转发
- **核心数据模型**：引入 sutando ORM，建立 user / model / vendor / vendor_model 表
- **供应商管理**：vendor 支持多 URL、默认 URL 预设、API 格式类型
- **记录服务**：记录用户请求、查询最新记录、记录非流式响应
- **协议格式**：支持 Anthropic 格式后端与请求
- **鉴权**：API 鉴权、system API、ROOT token 功能
- **运行模式**：本地 Node 模式 + Cloudflare Workers 模式，双模式测试
- **前端**：仪表盘、前后端整合
- **工程化**：Docker 部署支持、CI 测试配置

### V1.1: 厂商预置与部署完善 (已完成)

- **厂商预置类型**：新增 aliyun、aliyun_coding、volcengine_coding 类型，anthropic URL 自动补全
- **Docker 优化**：解决 better-sqlite3 等 native module 编译问题
- **环境变量**：支持 DB_PATH 指定数据库路径

### V1.2: 前端完善与连通性测试 (已完成)

- **错误处理统一**：抽取 customError，统一业务异常处理
- **前端完善**：RecordTable 组件抽取、批量获取记录关联并填充名称、仪表盘最近请求
- **厂商连通性测试**：新增 vendor test 端点与前端测试 UI
- **系统信息**：侧边栏显示系统版本
- **Root 用户**：支持 root 类型用户并透传 AI 请求

### V1.3: 流式记录与仪表盘 (已完成)

- **流式响应记录**：SSE 累加器、流式日志（stream log）写入、OpenAI 流式测试用例
- **请求日志**：RECORD_LOG_ENABLED 控制请求日志输出
- **仪表盘**：统计卡片、请求 token / 耗时显示
- **集成页**：展示 OpenAI / Anthropic 端点 URL 的集成配置页
- **性能**：前端 bundle 优化（tree-shaking、按需加载）、Docker 构建深度优化
- **工程化**：CI 升级 Node 22、发布流程文档、日志目录统一

### V1.4: 计费管理与 Responses API (已完成)

- **v4.0 计费管理**：用户余额管理、模型价格展示、用户表余额显示
- **OpenAI Responses API**：新增 Responses 协议支持与流式累加器，重排协议文档
- **记录查询增强**：记录列表按用户 / 模型过滤（多选）
- **推理模型响应**：支持 OpenAI reasoning_content
- **仪表盘性能**：优化统计查询、新增 record created_at 索引、避免全表扫描
- **模式命名统一**：cloud → worker、local → node
- **Docker**：多平台（multi-platform）构建支持

### V1.5: 桌面应用与协议转换 (已完成)

- **Tauri 桌面应用**：桌面端集成、PTY 启动后端 sidecar、自动登录（自动生成 root token）、托盘图标、splash 屏
- **自动协议转换**：OpenAI ↔ Anthropic ↔ Responses 双向协议转换架构（converter 重构 + 集成测试）
- **供应商模型管理**：模型列表 fetch / sync / 手动添加、vendor_model_id 上游模型名替换、模型可用性测试
- **供应商预置扩展**：mimo、mimo_token_plan、opencode_go、anthropic、google 等预设类型，URL 预设改由后端下发
- **失败类型区分**：record 增加 failed_code 字段，前端区分不同流式失败原因
- **用户管理**：用户启用 / 禁用状态、登录校验
- **流式健壮性**：客户端断开连接处理、工具调用结果顺序保持、socket 泄漏修复
- **高级设置**：CCH 改写选项、host_key 生成、升级检测、configService 内存缓存
- **开源准备**：仓库更名 gt_ai_gateway、Tauri 发布自动化、CI 完善

### V1.6: Windows 跨平台支持 (已完成)

- **Windows 构建**：新增 Windows 平台 CI 构建支持
- **跨平台重构**：后端启动逻辑抽取到 sys 模块、统一进程生命周期（stdin pipes）
- **桌面体验**：自动登录、splash 启动流程、隐藏原生标题栏、CMD 窗口隐藏

### V1.7: 客户端配置管理与插件体系 (已完成)

- **客户端配置管理（client manager）**：Claude Code / Codex 等客户端的连接配置管理
- **连接模式**：GATEWAY / VENDOR / OFFICIAL 三种连接模式
- **配置解析与改写**：config adapter 体系（解析、patch、写入本地配置）、备份 / 启用 / 同步 / 应用
- **插件系统**：CCH 改写、Responses API Prompt Cache Key 注入、Claude Code 追踪标记移除，抽取到 plugin 目录
- **供应商匹配**：后端实现供应商匹配（替代前端反查）
- **请求记录**：持久化 vendor model 映射、vendor test 对话框展示实际请求详情
- **部署**：Cloudflare 一键部署（GitHub Actions）
- **稳定性**：数据库 schema 自动校验、错误响应全局标准化
- **协议转换**：developer 角色 / 内置工具过滤等边界修复，TOML 解析库替换

### V1.8: 多上游路由、对象存储与高精度计费 (已完成 / 进行中)

- **多上游路由**：模型支持多上游通道，SINGLE / LOAD_BALANCE / FIRST_AVAILABLE 三种路由模式，负载均衡（按用户随机 / 按请求随机）、健康状态检查、故障转移（failover）与冷却机制
- **对象存储**：请求 / 响应 payload 从 record 表迁移到 storage_record / R2，支持存储位置选择（DB / R2 / auto）与开关
- **高精度计费**：余额 Decimal 化（整数微元存储）、按百万 Token 计价、免费模型（价格为 0）跳过计费、负余额策略
- **请求活动时间线**：一次请求一条记录 + request_activity 活动日志，first_token_latency 记录整体响应耗时
- **协议转换增强**：Responses ↔ OpenAI 双向转换、thinking block ↔ reasoning_content 映射、Anthropic adaptive thinking
- **供应商能力**：auth_mode（API Key / Bearer Token）、HTTP / SOCKS5 代理、skip_tls_verify
- **模块开关**：计费模块、API playground 模块可配置启用
- **运营能力**：日志轮转、自动更新检测、LLM models 端点、模型删除、请求记录删除
- **部署**：Cloudflare 自动部署完善、自定义 ROOT_TOKEN、R2 bucket 自动创建
- **开源合规**：许可证由 GPL v2 改为 MIT + 署名条款

---

## 技术栈

| 类别 | 技术 | 版本 |
|------|------|------|
| 运行时 | Node.js / Cloudflare Workers | 22+ |
| Web 框架 | Hono | - |
| ORM | sutando（基于 knex） | - |
| 数据库 | SQLite（better-sqlite3）/ Cloudflare D1 | - |
| 对象存储 | 本地文件 / Cloudflare R2 | - |
| 前端框架 | Vue 3 + Vite + TypeScript | - |
| 桌面应用 | Tauri（Rust + WebView） | - |
| 测试 | Vitest（node / worker 双模式） | - |

---

## 相关文档

- [文档索引](../../../GEMINI.md) — 项目文档总览
- [设计文档](../) — 路由、计费、客户端管理、协议等专项设计
- [版本规范](./版本文档规范.md) — 版本管理与文档命名规范
- [发布流程](../../tech/release_process.md) — 新版本发布流程
- [版本发布说明](../../../release_notes.md) — 当前版本更新内容
