# 1. 前端构建阶段 (强制在宿主机原生平台运行，避免 QEMU 仿真)
FROM --platform=$BUILDPLATFORM node:20-alpine AS frontend-builder
WORKDIR /app/frontend

# 复制前端依赖文件
COPY frontend/package*.json ./

# 安装前端依赖 (优化网络重试、超时和并发)
RUN npm config set fetch-retries 10 && \
    npm config set fetch-retry-mintimeout 3000 && \
    npm config set fetch-retry-maxtimeout 10000 && \
    npm config set fetch-timeout 30000 && \
    npm config set maxsockets 30 && \
    npm ci --loglevel info

# 复制前端源代码并执行构建
COPY frontend/ ./
RUN npm run build

# 2. 依赖和源码准备阶段 (针对每个目标架构分别运行)
FROM node:20-alpine AS builder
WORKDIR /app

# 复制后端依赖文件
COPY package*.json ./

# 安装后端依赖 (better-sqlite3 等 native 模块会在此根据目标架构进行编译/下载)
RUN npm config set fetch-retries 10 && \
    npm config set fetch-retry-mintimeout 3000 && \
    npm config set fetch-retry-maxtimeout 10000 && \
    npm config set fetch-timeout 30000 && \
    npm config set maxsockets 30 && \
    npm ci --loglevel info

# 从 frontend-builder 阶段直接复制构建产物
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# 复制后端源代码
COPY . .

# 3. 生产环境镜像阶段
FROM node:20-alpine
WORKDIR /app

# 安装运行时需要的库并创建目录
RUN apk add --no-cache libstdc++ && \
    mkdir -p /app/data

# 复制依赖文件和入口脚本
COPY package*.json docker-entrypoint.sh ./

# 赋予执行权限
RUN chmod +x docker-entrypoint.sh

# 复制构建产物、依赖和源代码
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/frontend/dist ./frontend/dist
COPY --from=builder /app/script ./script
COPY --from=builder /app/resource ./resource

# 暴露端口
EXPOSE 8787

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8787/welcome', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})" || exit 1

# 设置环境变量
ENV NODE_ENV=production \
    PORT=8787 \
    DB_PATH=/app/data/local.db \
    LOG_DIR=/app/data/log

# 启动应用
CMD ["./docker-entrypoint.sh"]