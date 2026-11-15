#!/usr/bin/env bash
#
# 统一测试锁 —— 同一时刻只允许一个 vitest 运行（node 全量必须串行）
#
# 背景：本项目 globalSetup 会删除并重建 test.db，任何两个 vitest 同时运行都会
#       互相踩库（SQLITE_READONLY_DBMOVED / no such table），产生大批假红。
#       历史上因锁写法错误（echo BUSY 后继续执行、强删他人锁、残留锁误判）
#       导致过三轮全量白跑。
#
# 用法：
#   ./scripts/with-test-lock.sh npm run backend:test
#   ./scripts/with-test-lock.sh npm run backend:test:worker
#   ./scripts/with-test-lock.sh npm run backend:test:coverage
#
# 规则：
#   1. 抢锁是原子的 mkdir；抢不到就退出（绝不「没抢到还继续跑」）。
#   2. 锁由 trap 保证释放，中途 Ctrl-C / kill 也不会残留。
#   3. 残留锁（有锁目录但无 vitest 进程）才允许清理。
#   4. 禁止手工 `rm -rf /tmp/gw-test.lock` 去顶掉别人正在跑的锁。
#   5. 禁止手工 `rm test.db`（globalSetup 自己会重建）。
#
# 建议在 package.json 里挂别名：
#   "test:locked": "scripts/with-test-lock.sh npm run backend:test"
#
set -euo pipefail

LOCK_DIR="${TEST_LOCK_DIR:-/tmp/gw-test.lock}"

release_lock() {
    local code=$?
    rmdir "$LOCK_DIR" 2>/dev/null || true
    if [ "$code" -ne 0 ]; then
        echo "[test-lock] 命令退出码 $code，锁已释放：$LOCK_DIR" >&2
    else
        echo "[test-lock] 运行完成，锁已释放：$LOCK_DIR" >&2
    fi
    exit "$code"
}

acquire_lock() {
    if mkdir "$LOCK_DIR" 2>/dev/null; then
        echo "[test-lock] 获得锁：$LOCK_DIR (pid $$)" >&2
        return 0
    fi

    # 已有锁：区分「真的有人在跑」与「残留锁」
    # 匹配 `bin/vitest`（真实进程）而不是裸 `vitest`：本脚本的命令行里本身就带
    # `... npx vitest ...`，用裸关键词会把自己的 shell 也当成「有人在跑」，
    # 导致残留锁永远清不掉。
    if pgrep -f "[b]in/vitest" >/dev/null 2>&1; then
        echo "[test-lock] 拒绝启动：已有 vitest 进程在运行（锁 $LOCK_DIR）。" >&2
        echo "[test-lock] 请等对方跑完再执行，不要手工删除该锁目录。" >&2
        exit 1
    fi

    echo "[test-lock] 检测到残留锁（无 vitest 进程），清理后重试。" >&2
    rm -rf "$LOCK_DIR"
    if ! mkdir "$LOCK_DIR" 2>/dev/null; then
        echo "[test-lock] 抢锁失败（可能有人同时抢到），退出。" >&2
        exit 1
    fi
    echo "[test-lock] 获得锁：$LOCK_DIR (pid $$)" >&2
}

if [ "$#" -eq 0 ]; then
    echo "用法: $0 <command...>" >&2
    exit 2
fi

acquire_lock
trap release_lock EXIT INT TERM

echo "[test-lock] 执行：$*" >&2
"$@"
