#!/usr/bin/env bash
# gtgw e2e 冒烟：真二进制 + 真 mock 网关（HTTP 往返），可重复运行且**幂等**。
#
#   bash cli/scripts/e2e.sh              # 用 cli/dist/gtgw（不存在则先构建）
#   BIN=/path/to/gtgw bash cli/scripts/e2e.sh
#
# 幂等做法（对应 #256 验收的 O1）：
#   每轮 mktemp -d 独立工作目录 + 随机空闲端口 + 全新 mock 进程 + 日志只落在该轮临时目录；
#   脚本最后**连跑两轮并 diff**，任何跨轮残留都会让 diff 非空 ⇒ 直接红。
#
# 退出码：0 全过；1 有用例失败。
set -uo pipefail

CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${BIN:-$CLI_DIR/dist/gtgw}"
TOKEN="sk-abcdefghijkl"
FAILED=0

if [ ! -x "$BIN" ]; then
  echo "[e2e] $BIN 不存在，先构建"
  bash "$CLI_DIR/scripts/build.sh" >/dev/null || exit 1
fi

pass() { echo "  ok   $*"; }
fail() { echo "  FAIL $*"; FAILED=$((FAILED + 1)); }

# expect_exit <期望退出码> <说明> -- <命令...>
expect_exit() {
  local want=$1 desc=$2
  shift 3
  "$@" >/dev/null 2>&1
  local rc=$?
  if [ "$rc" = "$want" ]; then
    pass "$desc (exit=$rc)"
  else
    fail "$desc (exit=$rc, 期望 $want)"
  fi
}

free_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}

wait_ready() {  # wait_ready <port>
  python3 - "$1" <<'PY'
import socket, sys, time
port = int(sys.argv[1])
for _ in range(100):
    try:
        s = socket.create_connection(("127.0.0.1", port), timeout=0.2)
        s.close()
        sys.exit(0)
    except OSError:
        time.sleep(0.1)
sys.exit(1)
PY
}

# run_suite：起一套全新环境跑全部用例，结果打印到 stdout（由调用方重定向落盘）
run_suite() {
  local tmp port pid
  tmp="$(mktemp -d)"
  port="$(free_port)"
  python3 "$CLI_DIR/scripts/mock_gateway.py" "$port" "$tmp/mock.log" &
  pid=$!
  wait_ready "$port" || { echo "mock 启动失败"; return 1; }

  local MOCK="http://127.0.0.1:$port"
  # 配置目录统一为 `<家目录>/.gtgw`（2026-11-15 起），所以隔离方式是**注入 HOME**：
  # e2e 里所有 gtgw 调用都落在 $tmp/home/.gtgw，真实 ~/.gtgw 不会被创建或改写。
  local HOME_DIR="$tmp/home"
  mkdir -p "$HOME_DIR"
  export HOME="$HOME_DIR"
  export USERPROFILE="$HOME_DIR"   # Windows 上家目录看 USERPROFILE
  unset GTGW_URL GTGW_TOKEN GTGW_TENANT GTGW_TAURI_CONFIG

  echo "== version =="
  "$BIN" --version
  echo "== login =="
  "$BIN" login --url "$MOCK" --token "$TOKEN" --profile local && echo "[login exit=0]"
  echo "== status --json =="
  "$BIN" status --json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print("version:", d["system"]["version"], "status:", d["status"])'
  echo "== status 人类输出（token 不得明文） =="
  "$BIN" status 2>&1 | sed -n '1,5p'
  echo "== dashboard / update =="
  "$BIN" dashboard 2>&1 | sed -n '1,3p'
  "$BIN" update check 2>&1 | sed -n '1,3p'
  echo "== config 读写 =="
  "$BIN" config get 2>&1 | sed -n '1,4p'
  "$BIN" config set --key theme=dark >/dev/null 2>&1 && echo "[config set exit=0]"
  "$BIN" config get 2>&1 | sed -n '1,4p'
  echo "== config set --file -（stdin） =="
  echo '{"theme":"light","site_name":"from-stdin"}' | "$BIN" config set --file - >/dev/null 2>&1 && echo "[stdin exit=0]"
  "$BIN" config get 2>&1 | sed -n '1,4p'
  echo "== login --from-tauri（夹具注入） =="
  printf '{"host":"0.0.0.0","port":%s,"root_token":"%s"}' "$port" "$TOKEN" > "$tmp/tauri.json"
  GTGW_TAURI_CONFIG="$tmp/tauri.json" "$BIN" login --from-tauri --profile tauri 2>&1 | sed -n '1,3p'
  echo "== 退出码四态 =="
  expect_exit 0 "200 正常" -- "$BIN" status --url "$MOCK" --token "$TOKEN"
  expect_exit 3 "403 鉴权" -- "$BIN" status --url "$MOCK" --token forbidden
  expect_exit 1 "400 业务" -- "$BIN" status --url "$MOCK" --token bad-request
  expect_exit 1 "500 服务端" -- "$BIN" status --url "$MOCK" --token boom
  expect_exit 2 "参数错（未知 flag）" -- "$BIN" status --no-such-flag
  echo "== 请求日志（脱敏后） =="
  python3 - "$tmp/mock.log" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1], encoding="utf-8") if l.strip()]
# 顺序必须规范化：`gtgw dashboard` 是**并发**请求 dashboard.json 与 recent.json，
# 服务端收到它们的先后在现代码/CI 上不固定（本机偶然稳定，CI 上直接让两轮 diff 红了一次）。
# 请求集合才是要断言的东西，顺序不是，所以按 (path, method) 排序后再打印。
rows.sort(key=lambda r: (r["path"], r["method"]))
print(f"requests={len(rows)}")
for r in rows:
    print(f'  {r["method"]} {r["path"]} token={r["token"]}')
PY

  kill -9 "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  rm -rf "$tmp"
}

# 规范化：端口号、每轮临时目录都会变，替换掉才能跨轮 diff
normalize() {
  sed -E -e 's|127\.0\.0\.1:[0-9]{2,5}|127.0.0.1:__PORT__|g' \
         -e 's|/var/folders/[^ "]+|__TMP__|g' \
         -e 's|/tmp/tmp\.[A-Za-z0-9]+|__TMP__|g' \
         -e 's|\$tmp|__TMP__|g' "$1"
}

echo "===== 第一轮 ====="
RAW1="$(mktemp)" SUITE1="$(mktemp)"
run_suite > "$RAW1" 2>&1
normalize "$RAW1" > "$SUITE1"
cat "$SUITE1" | sed -n '1,200p'

echo ""
echo "===== 第二轮（幂等性检查）====="
RAW2="$(mktemp)" SUITE2="$(mktemp)"
run_suite > "$RAW2" 2>&1
normalize "$RAW2" > "$SUITE2"

echo ""
if diff -u "$SUITE1" "$SUITE2" > /tmp/gtgw-e2e-diff.txt 2>&1; then
  pass "两轮输出完全一致（幂等）"
else
  fail "两轮输出不一致（非幂等），差异："
  sed -n '1,40p' /tmp/gtgw-e2e-diff.txt
fi

echo ""
echo "===== 汇总 ====="
echo "失败项：$FAILED"
rm -f "$SUITE1" "$SUITE2" "$RAW1" "$RAW2"
if [ "$FAILED" -ne 0 ]; then
  echo "结果：FAIL"
  exit 1
fi
echo "结果：PASS"
