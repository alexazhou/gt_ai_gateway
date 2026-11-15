#!/usr/bin/env bash
# 回退连接破坏性闸门的 e2e：用 GTGW_TAURI_CONFIG 注入一份**指向 mock 的假桌面端配置**，
# 断言「破坏性命令默认拒绝（退出码 2、零请求）」，只有加 --allow-fallback-destructive 才放行。
#
#   bash cli/scripts/e2e-fallback-destructive.sh [BIN]
#
# 由来：#257 验收事故 —— mock 没起来、login 静默失败，CLI 按 Tauri 回退连到本机真实网关
# （127.0.0.1:6722），`clear-payload` / `clear-all` / `recover-orphans` 真实执行。P3 加了闸门，
# 但端到端当时只能用单测证明（读真实桌面端配置正是事故路径，验收人也不肯碰）。
# P4 给 tauri 配置加了 `GTGW_TAURI_CONFIG` 注入，于是**回退路径可以安全地端到端造出来**：
# 把假配置指向 mock，既走完整回退解析，又不会碰到真实网关。
#
# 依赖：破坏性命令（record clear-payload）+ --allow-fallback-destructive 都来自 P3。
# 缺依赖时以退出码 3 失败，**不跳过**——跳过就等于这条闸门没人端到端守。
set -uo pipefail

CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${1:-${BIN:-$CLI_DIR/dist/gtgw}}"
TOKEN="sk-abcdefghijkl"
FAILED=0

pass() { echo "  ok   $*"; }
fail() { echo "  FAIL $*"; FAILED=$((FAILED + 1)); }

if [ ! -x "$BIN" ]; then
  echo "[fallback-e2e] 二进制不存在：$BIN" >&2
  exit 3
fi

# 依赖探测：没有 clear-payload 或没有放行 flag，就没法验证闸门。
# 探命令存在性只能看 root help 的命令清单：`record clear-payload --help` 在命令不存在时
# 也会被 cobra 当 root help 处理并 exit 0（第一版踩过），不能用来判断。
if ! "$BIN" --help 2>/dev/null | grep -qE '^  record[[:space:]]'; then
  # 固定前缀供验收人 grep：区分「依赖缺失 exit 3」与「断言失败 exit 1」（详见 e2e-shell-env.sh 同处注释）
  echo "SKIP-REASON: 需要 P3 命令 \`record clear-payload\`，当前树没有（feat/cli-p4 以 P1 为基点）" >&2
  exit 3
fi
if ! "$BIN" --help 2>&1 | grep -q -- '--allow-fallback-destructive'; then
  echo "SKIP-REASON: 需要 P3 的全局 flag \`--allow-fallback-destructive\`，当前树没有" >&2
  exit 3
fi

free_port() {
  python3 - <<'PY'
import socket
s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()
PY
}

TMP="$(mktemp -d)"
PORT="$(free_port)"
python3 "$CLI_DIR/scripts/mock_gateway.py" "$PORT" "$TMP/mock.log" &
MOCK_PID=$!
trap 'kill -9 "$MOCK_PID" 2>/dev/null; rm -rf "$TMP"' EXIT

for _ in $(seq 1 100); do
  if python3 -c "import socket,sys;socket.create_connection(('127.0.0.1',$PORT),timeout=0.2)" 2>/dev/null; then break; fi
  sleep 0.1
done

# 请求计数方式（验收人对齐用）：**数 mock 日志文件的行数**（mock_gateway.py 每处理一个请求追加一行 JSON）；
# 不依赖任何"计数接口"，也不看 CLI 自己的说法 —— 唯一事实来源是服务端收到的请求条数。
request_count() { if [ -f "$TMP/mock.log" ]; then wc -l < "$TMP/mock.log" | tr -d ' '; else echo 0; fi; }

# 假桌面端配置：host/port 指向 mock，root_token 是 mock 认的 token
printf '{"host":"127.0.0.1","port":%s,"root_token":"%s"}' "$PORT" "$TOKEN" > "$TMP/tauri.json"

export XDG_CONFIG_HOME="$TMP/config"
unset GTGW_URL GTGW_TOKEN GTGW_TENANT GTGW_PROFILE
export GTGW_TAURI_CONFIG="$TMP/tauri.json"

echo "== 0) 回退连接确实生效（凭假桌面端配置能读到网关）=="
OUT="$("$BIN" status --json 2>&1)"; RC=$?
if [ "$RC" = "0" ]; then
  pass "status 走回退连接成功（exit=0）"
  echo "$OUT" | grep -q "\"status\"" && pass "回退连接读到真实 mock 响应" || fail "响应不像 mock"
else
  fail "回退连接没生效（status exit=$RC）：$OUT"
fi

echo "== 1) -y 不足以放行：必须 exit 2 且零请求 =="
BEFORE="$(request_count)"
"$BIN" -y record clear-payload >/dev/null 2>"$TMP/nofallback.err"; RC=$?
AFTER="$(request_count)"
echo "  exit=$RC，请求数 $BEFORE→$AFTER"
sed 's/^/      stderr: /' "$TMP/nofallback.err" | head -4
[ "$RC" = "2" ] && pass "-y 下 exit=2" || fail "-y 下 exit=$RC（期望 2）"
[ "$BEFORE" = "$AFTER" ] && pass "零请求（破坏性命令没有打到网关）" || fail "发出了 $((AFTER - BEFORE)) 个请求"
grep -q '桌面端配置' "$TMP/nofallback.err" && pass "stderr 指明连接来自桌面端配置" || fail "stderr 未指明连接来源"
grep -q -- '--allow-fallback-destructive' "$TMP/nofallback.err" && pass "stderr 给出放行方式" || fail "stderr 未给出放行方式"

echo "== 2) 显式放行后才会真的发请求 =="
BEFORE="$(request_count)"
"$BIN" -y --allow-fallback-destructive record clear-payload >/dev/null 2>"$TMP/allow.err"; RC=$?
AFTER="$(request_count)"
echo "  exit=$RC，请求数 $BEFORE→$AFTER"
# 这里断言的是「闸门不再拦」，不是「业务成功」：mock 是 P1 路由集，没有 clear-payload，
# 服务端会回 404 ⇒ CLI exit 1。若它被闸门拦住会是 2；0 只在 mock 有该路由时出现。
if [ "$RC" != "2" ]; then
  pass "放行后不再被闸门拒绝（exit=$RC；mock 无该路由时 1，有则 0）"
else
  fail "放行后仍被闸门拒绝（exit=2）"
fi
[ "$AFTER" -gt "$BEFORE" ] && pass "放行后请求真的发出（server 收到 $((AFTER - BEFORE)) 个：$(tail -n1 "$TMP/mock.log" 2>/dev/null | cut -c1-120)）" || fail "放行后仍无请求"

echo "== 3) 收尾：回退连接下 -y 与放行 flag 的行为差异如上（退出码 2 vs 0）=="

echo ""
echo "失败项：$FAILED"
if [ "$FAILED" -ne 0 ]; then
  echo "结果：FAIL"
  exit 1
fi
echo "结果：PASS"
