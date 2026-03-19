# 1. 前端构建阶段 (强制在宿主机原生平台运行，避免 QEMU 仿真)
FROM --platform=$BUILDPLATFORM node:20-alpine AS frontend-builder
WORKDIR /app/frontend

# 复制前端依赖和配置文件
COPY frontend/package*.json ./
COPY frontend/tsconfig*.json ./

# 安装前端依赖
RUN npm config set fetch-retries 10 && \
    npm config set fetch-retry-mintimeout 3000 && \
    npm config set fetch-retry-maxtimeout 10000 && \
    npm config set fetch-timeout 30000 && \
    npm config set maxsockets 30 && \
    npm ci --loglevel info

# 复制前端源代码并构建
COPY frontend/ ./
RUN npm run build

# 2. 依赖和源码准备阶段 (针对每个目标架构分别运行)
FROM node:20-alpine AS builder
WORKDIR /app

# 安装后端依赖 (better-sqlite3 等 native 模块会在此根据目标架构编译)
COPY package*.json ./
RUN npm config set fetch-retries 10 && \
    npm config set fetch-retry-mintimeout 3000 && \
    npm config set fetch-retry-maxtimeout 10000 && \
    npm config set fetch-timeout 30000 && \
    npm config set maxsockets 30 && \
    npm ci --loglevel info

# 复制前端构建产物和后端源代码
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist
COPY script ./script
COPY src ./src
COPY resource ./resource
COPY package*.json ./
COPY docker-entrypoint.sh ./
COPY tsconfig.json ./

# 3. 生产环境镜像阶段
FROM node:20-alpine
WORKDIR /app

# 安装运行时依赖、创建目录、设置权限 (合并为一层)
RUN apk add --no-cache libstdc++ && \
    mkdir -p /app/data

# 复制依赖、入口脚本和源代码
COPY --from=builder \
    /app/node_modules ./node_modules \
    /app/package*.json ./package*.json \
    /app/docker-entrypoint.sh ./docker-entrypoint.sh \
    /app/src ./src \
    /app/frontend/dist ./frontend/dist \
    /app/script ./script \
    /app/resource ./resource

RUN chmod +x docker-entrypoint.sh

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8787/welcome', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})" || exit 1

ENV NODE_ENV=production \
    PORT=8787 \
    DB_PATH=/app/data/local.db \
    LOG_DIR=/app/data/log

CMD ["./docker-entrypoint.sh"]