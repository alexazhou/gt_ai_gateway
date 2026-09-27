# Docker 部署文档

本文档描述如何使用 Docker 部署 serverless-ai-gateway。

---

## 1. 拉取镜像

本项目推荐使用 GitHub Container Registry (ghcr.io) 提供的官方镜像：

```bash
docker pull ghcr.io/alexazhou/gt_ai_gateway:latest
```

## 2. 启动容器

直接使用 `docker run` 启动服务：

```bash
docker run -d \
    --name gt_ai_gateway \
    -p 8787:8787 \
    -v $(pwd)/data:/app/data \
    -e ROOT_TOKEN=your-root-token-here \
    ghcr.io/alexazhou/gt_ai_gateway:latest
```

> **注意**：`ROOT_TOKEN` 是系统最高权限 Token，用于登录管理后台。请替换成自己生成的值
> （`openssl rand -hex 32`）——`your-root-token-here` 只是「请改成你自己的」的标记，
> 照抄它、或留空都不会生效：root 权限会失效、管理后台无法登录（服务照常启动，启动日志会提示）。

服务启动后，访问 `http://localhost:8787` 即可登录进入管理后台。

### 数据持久化说明

服务使用单个挂载目录来持久化所有数据：

| 宿主机目录 | 容器目录 | 说明 |
|-----------|---------|------|
| `./data` | `/app/data` | 存放 SQLite 数据库文件和每日应用日志 |

日志文件会自动写入到宿主机的 `./data/log` 目录下，按日期命名（如 `app-2026-03-16.log`）。

---

## 3. 常用操作

```bash
# 实时查看系统运行日志
docker logs -f gt_ai_gateway

# 停止服务容器
docker stop gt_ai_gateway

# 重新启动服务容器
docker start gt_ai_gateway

# 删除容器（不会删除 ./data 挂载目录下的数据）
docker rm -f gt_ai_gateway
```

### 数据库维护工具 (进阶)

如果您需要直接在容器内执行数据库状态检查或升级等维护命令：

```bash
# 检查数据库状态
docker exec -it gt_ai_gateway npx tsx script/db.ts status --env node

# 强制执行数据库表结构升级（通常容器启动时会自动执行，无需手动调用）
docker exec -it gt_ai_gateway npm run db:migrate:node
```

---

## 相关文档

- **后端开发手册**：`../dev/BackendDevManual.md`
- **前端开发手册**：`../dev/FrontendDevManual.md`
- **LLM API 使用指南**：`../usage/LlmApiUsage.md`
