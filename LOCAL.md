# 本地运行说明

这个项目现在支持两种运行模式：

## 1. Cloudflare Workers 模式（生产环境）

```bash
npm run dev
```

## 2. 本地 Node.js 模式（开发/测试）

```bash
# 开发模式
npm run dev:local

# 生产模式
npm start
```

## 环境变量

本地运行时可以通过环境变量配置端口：

```bash
PORT=8080 npm run dev:local
```

## 数据库

- **Cloudflare Workers**: 使用 Cloudflare D1 数据库
- **本地 Node.js**: 使用 SQLite 数据库 (local.db)

## 功能差异

本地模式和 Cloudflare Workers 模式功能完全相同，包括：

- 用户管理
- 供应商管理
- 模型管理
- 请求记录
- AI API 代理
- SSE 流式响应支持

## 测试 API

服务器启动后，可以访问：

```bash
# 健康检查
curl http://localhost:3000/

# 创建用户
curl -X POST http://localhost:3000/user/create.json \
  -H "Content-Type: application/json" \
  -d '{"name": "test-user"}'

# 获取用户列表
curl http://localhost:3000/user/list.json

# 创建供应商
curl -X POST http://localhost:3000/vendor/create.json \
  -H "Content-Type: application/json" \
  -d '{"type": "aliyun", "name": "aliyun-test", "token": "your-api-key", "url": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"}'

# 创建模型
curl -X POST http://localhost:3000/model/create.json \
  -H "Content-Type: application/json" \
  -d '{"name": "qwen-turbo", "vendor_id": 1}'
```
