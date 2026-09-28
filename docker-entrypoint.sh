#!/bin/sh

set -e

# 设置数据库文件路径 (与 Dockerfile 中一致)
DB_PATH=${DB_PATH:-/app/data/local.db}
echo "Using database at: $DB_PATH"

# 确保数据目录存在
mkdir -p $(dirname "$DB_PATH")

# 迁移不在这里做：后端启动时执行（见 ormService.applyStartupMigrations），
# 由环境变量 MIGRATION_MODE 控制（execute / check / off，默认 execute）。

# 启动应用
echo "Starting application..."
exec npm run backend:start
