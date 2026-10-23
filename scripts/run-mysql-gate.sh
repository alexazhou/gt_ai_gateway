#!/usr/bin/env bash
#
# T7 本地 MySQL 门入口（`npm run test:mysql` → 本脚本）
#
# 为什么要有这个脚本，而不是把一长串环境变量塞进 package.json：
# 最初写成
#   "test:mysql": "npx tsx script/check-mysql-gate.ts && DB_DRIVER=mysql … vitest …"
# —— 首跑就红在 `[FATAL] DB_DRIVER=sqlite`：`&&` 后面的 `VAR=值 命令` 只对那一条命令生效，
# **前置检查拿不到 DB_DRIVER**，于是门自己把自己拦住了。
# 正确做法是 `export` 到整个脚本作用域，让前置检查与 vitest 看到**同一份**环境。
# （这也是同一类错误的第 N 次：环境/退出码这类"传递"最容易在链式命令里丢。）
#
# 行为：
#   1. 前置检查：DB_DRIVER=mysql 但连不上 → 直接失败（禁止静默回退 sqlite）
#   2. 跑与 sqlite 门同一套用例，只换方言（vitest.mysql.config.ts）
#   3. 退出码原样透传（不做管道，避免 $? 被 tee/tail 吞掉）
set -euo pipefail

export DB_DRIVER=mysql
export TEST_MODE=node
export DB_HOST="${DB_HOST:-127.0.0.1}"
export DB_PORT="${DB_PORT:-3306}"
export DB_USER="${DB_USER:-root}"
export DB_PASSWORD="${DB_PASSWORD:-rootpass}"
export DB_NAME="${DB_NAME:-test}"

cd "$(dirname "$0")/.."

# CI 的 MySQL job 在跑测试前会 `npm run frontend:build`；本地若不建，frontend 用例会因为
# 找不到 frontend/dist 而红 —— 那是一条**与 MySQL 无关的红**，会让「本地红点清单」与 CI 对不上。
# 这里只警告不阻断（门的主职责是方言差异，不是替前端构建把关）。
if [ ! -d frontend/dist ]; then
    echo "[mysql-gate][WARN] frontend/dist 不存在 → tests/api/frontend/* 会红（CI 会先跑 frontend:build）。"
    echo "[mysql-gate][WARN] 本地请先 `npm run frontend:build`，或从已构建的工作区软链过来。"
fi

npx tsx script/check-mysql-gate.ts

exec npx vitest --run --config vitest.mysql.config.ts "$@"
