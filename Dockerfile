# 1. 前端构建阶段 (强制在宿主机原生平台运行，避免 QEMU 仿真)
FROM --platform=$BUILDPLATFORM node:24-alpine AS frontend-builder
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
FROM node:24-alpine AS builder
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

# 0. CLI 构建阶段 (gtgw：Go 静态单文件，随镜像一起分发)
# 用 --platform=$BUILDPLATFORM + TARGETOS/TARGETARCH 交叉编译，让 go build 跑在构建机原生架构上，
# 而不是让 QEMU 去仿真 arm64 的 go 编译器（后者慢 5~10 倍，且容易在 buildx 下偶发 OOM）。
# 版本号唯一来源是仓库根 package.json，与 release/CI 的注入口径一致。
FROM --platform=$BUILDPLATFORM golang:1.22-alpine AS cli-builder
WORKDIR /src/cli

# buildx 自动注入的目标平台
ARG TARGETOS
ARG TARGETARCH

# 先只拷贝依赖清单，命中层缓存；package.json 供下面取 version
COPY package.json /src/package.json
COPY cli/go.mod cli/go.sum ./
RUN go mod download

COPY cli/ ./
# CGO_ENABLED=0 ⇒ 纯静态：不依赖目标镜像的 libc，alpine(musl) 与 debian(glibc) 都能直接跑
RUN VERSION="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' /src/package.json | head -1)" && \
    echo "cli version = $VERSION ($TARGETOS/$TARGETARCH)" && \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -buildvcs=false \
      -ldflags "-s -w -X main.version=$VERSION" \
      -o /out/gtgw .

# 3. 生产环境镜像阶段
FROM node:24-alpine
WORKDIR /app

# 安装运行时需要的库并创建目录
RUN apk add --no-cache libstdc++ && \
    mkdir -p /app/data

# 复制依赖文件和入口脚本
COPY --from=builder /app/package.json /app/package-lock.json /app/tsconfig.json ./
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh

# 赋予执行权限
RUN chmod +x docker-entrypoint.sh

# 复制构建产物、依赖和源代码
# 注意：不能使用多行 COPY 格式（如 COPY --from=builder \n ...），在 buildx 跨架构构建时会出现文件找不到的错误
# 必须使用单行 COPY 格式以确保兼容性
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/frontend/dist ./frontend/dist
COPY --from=builder /app/script ./script
COPY --from=builder /app/resource ./resource


# gtgw CLI：从 cli-builder 阶段取静态二进制
# 注意：与上面的约定一致，必须用单行 COPY（多行格式在 buildx 跨架构构建时会报文件找不到）
COPY --from=cli-builder /out/gtgw /usr/local/bin/gtgw
# 构建期自检：二进制能在最终镜像里跑起来（静态，无需额外运行库）；失败就让构建红
RUN gtgw --version

# 暴露端口
EXPOSE 8787

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8787/welcome', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})" || exit 1

# 设置环境变量
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DB_PATH=/app/data/local.db \
    LOG_DIR=/app/data/log

# 启动应用
CMD ["./docker-entrypoint.sh"]