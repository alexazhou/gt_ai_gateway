# Serverless AI Gateway

一个轻量级的 AI 服务网关，支持 OpenAI 和 Anthropic API 格式的请求转发、模型路由和请求记录。

## 文档索引

- **[后端开发手册](doc/BackendDevManual.md)**: 包含后端架构、环境配置、API 开发、数据库管理及部署说明（Cloudflare / Docker）。
- **[前端开发手册](doc/FrontendDevManual.md)**: 包含前端环境配置、项目结构及开发命令。
- **[测试手册](doc/TestManual.md)**: 详细描述测试环境的架构设计、操作流程及调试方法。
- **[编程规范](GEMINI.md)**: 项目代码规范、开发技巧及 Git 提交指南。

## 主要功能

- **API 网关**: 统一转发请求到上游 AI 服务（OpenAI、Anthropic、自定义）
- **模型路由**: 支持多个 AI 类型和供应商的映射
- **用户管理**: 基于 Token 的用户认证系统
- **请求记录**: 完整记录所有 AI 请求和响应
- **流式响应**: 支持 SSE（Server-Sent Events）流式输出

## 快速开始

### 1. 环境准备
确保已安装 Node.js (推荐 v20+)。

### 2. 安装依赖
```bash
# 安装根目录和后端依赖
npm install

# 安装前端依赖
cd frontend && npm install
```

### 3. 配置环境
复制 `.env.example` 为 `.env` 并配置 `ROOT_TOKEN` 等变量。详细配置请参考 [后端开发手册 - 环境配置](doc/BackendDevManual.md#环境配置)。

### 4. 启动服务
```bash
# 启动后端 (Node 模式，自动监听代码变更并重启)
npm run backend:dev:local

# 启动前端 (在新终端)
npm run frontend:dev
```

## 部署与测试

- **部署**: 支持 Cloudflare Workers、Docker 及传统 Node.js 部署。详见 [后端开发手册 - 部署说明](doc/BackendDevManual.md#部署说明)。
- **测试**: 运行 `npm run backend:test` 执行后端测试。详见 [测试手册](doc/TestManual.md)。

## 许可证

MIT License
