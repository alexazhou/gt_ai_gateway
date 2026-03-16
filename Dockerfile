FROM node:20-alpine AS builder

WORKDIR /app

# 复制后端依赖文件
COPY package*.json ./

# 安装后端依赖 (优化网络重试和并发)
RUN npm config set fetch-retries 10 && \
    npm config set fetch-retry-mintimeout 3000 && \
    npm config set fetch-retry-maxtimeout 10000 && \
    npm config set fetch-timeout 30000 && \
    npm config set maxsockets 30 && \
    npm ci --loglevel info

# 复制前端依赖文件
COPY frontend/package*.json ./frontend/

# 安装前端依赖 (同步优化网络设置)
RUN cd frontend && \
    npm config set fetch-retries 10 && \
    npm config set fetch-retry-mintimeout 3000 && \
    npm config set fetch-retry-maxtimeout 10000 && \
    npm config set fetch-timeout 30000 && \
    npm config set maxsockets 30 && \
    npm ci --loglevel info

# 复制源代码
COPY . .

# 构建前端
RUN npm run frontend:build

# 编译 TypeScript（如果需要）
# 注意：项目使用 tsx 运行，不需要编译，但为了优化可以添加

# 生产镜像
FROM node:20-alpine

WORKDIR /app

# 安装运行时需要的库 (better-sqlite3 需要 libstdc++)
RUN apk add --no-cache libstdc++

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

# 创建数据库文件目录
RUN mkdir -p /app/data

# 暴露端口
EXPOSE 8787

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8787/welcome', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})" || exit 1

# 设置环境变量
ENV NODE_ENV=production
ENV PORT=8787
ENV DB_PATH=/app/data/local.db

# 启动应用
CMD ["./docker-entrypoint.sh"]