#!/usr/bin/env bash
# 本机桌面端 profile 的破坏性闸门 e2e。
#
#   bash cli/scripts/e2e-fallback-destructive.sh [BIN]
#
# 场景（2026-11-15 Operator 口径 A 之后的版本）：
#   1. 用 GTGW_TAURI_CONFIG 注入一份**指向 mock 的假桌面端配置**；
#   2. `gtgw login --from-tauri --profile desk` 把它存成一个带「来自本机桌面端」标记的 profile；
#   3. `profile use desk` 确认它是当前 profile；
#   4. 破坏性命令 `record clear-payload` 默认拒绝（退出码 2、服务端零请求），`-y` 也不放行；
#   5. 加 `--allow-local-destructive` 后才真的发出请求（服务端请求数 +1）。
#
# 文件名里的 "fallback" 是历史遗留：P3/P4 时代闸门判据是「Tauri 隐式回退」，
# 该层已在本次变更中整层删除，判据改为「当前 profile 是否带本机桌面端标记」。
# 文件名保留是为了不动 CI 引用，脚本内容与断言都是新口径。
#
# 由来：#257 验收事故 —— mock 没起来、login 静默失败，CLI 隐式回退连到本机真实网关
# （127.0.0.1:6722），`clear-payload` / `clear-all` / `recover-orphans` 真实执行。
#
# 依赖：`record clear-payload`（P3）+ 全局 flag `--allow-local-destructive`。
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
  echo "SKIP-REASON: 需要 P3 命令 \`record clear-payload\`，当前树没有" >&2
  exit 3
fi
if ! "$BIN" --help 2>&1 | grep -q -- '--allow-local-destructive'; then
  echo "SKIP-REASON: 需要全局 flag \`--allow-local-destructive\`，当前树没有" >&2
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

# 家目录隔离：配置一律落 $TMP/home/.gtgw（真实 ~/.gtgw 不会被碰）。
export HOME="$TMP/home"
export USERPROFILE="$TMP/home"
mkdir -p "$HOME"
unset GTGW_URL GTGW_TOKEN GTGW_TENANT GTGW_PROFILE

# 假桌面端配置：host/port 指向 mock，root_token 是 mock 认的 token
printf '{"host":"127.0.0.1","port":%s,"root_token":"%s"}' "$PORT" "$TOKEN" > "$TMP/tauri.json"
export GTGW_TAURI_CONFIG="$TMP/tauri.json"

echo "== 0) login --from-tauri 造出本机桌面端 profile =="
"$BIN" login --from-tauri --profile desk >"$TMP/login.out" 2>"$TMP/login.err"; RC=$?
[ "$RC" = "0" ] && pass "login --from-tauri exit=0" || fail "login --from-tauri exit=$RC：$(cat "$TMP/login.err")"
CFG="$TMP/home/.gtgw/config.json"
if [ -f "$CFG" ]; then
  pass "配置落在 \\\$HOME/.gtgw/config.json"
  grep -q '"from_desktop": true' "$CFG" && pass "profile 带 from_desktop 持久标记" || fail "profile 缺 from_desktop 标记：$(cat "$CFG")"
else
  fail "配置没落在 \\\$HOME/.gtgw/config.json（旧路径必须不再使用）"
fi
if [ -f "$TMP/home/.config/gtgw/config.json" ]; then
  fail "居然写出了旧路径 \\\$HOME/.config/gtgw/config.json"
else
  pass "没有写出旧路径 \\\$HOME/.config/gtgw/config.json"
fi

echo "== 0.1) profile use desk（切换当前 profile）=="
"$BIN" profile use desk >/dev/null 2>&1 && pass "profile use exit=0" || fail "profile use 失败"
"$BIN" profile list 2>/dev/null | tee "$TMP/list.out" | sed 's/^/      /'
grep -q '本机桌面端' "$TMP/list.out" && pass "profile list 显示来源「本机桌面端」" || fail "profile list 没显示来源"

echo "== 0.2) 只读命令照常可用（闸门只拦破坏性操作）=="
BEFORE="$(request_count)"
"$BIN" status --json >/dev/null 2>&1; RC=$?
AFTER="$(request_count)"
[ "$RC" = "0" ] && pass "status exit=0" || fail "status exit=$RC"
[ "$AFTER" -gt "$BEFORE" ] && pass "只读请求正常发出（$BEFORE→$AFTER）" || fail "只读请求没发出"

echo "== 1) -y 不足以放行：必须 exit 2 且零请求 =="
BEFORE="$(request_count)"
"$BIN" -y record clear-payload >/dev/null 2>"$TMP/nofallback.err"; RC=$?
AFTER="$(request_count)"
echo "  exit=$RC，请求数 $BEFORE→$AFTER"
sed 's/^/      stderr: /' "$TMP/nofallback.err" | head -5
[ "$RC" = "2" ] && pass "-y 下 exit=2" || fail "-y 下 exit=$RC（期望 2）"
[ "$BEFORE" = "$AFTER" ] && pass "零请求（破坏性命令没有打到网关）" || fail "发出了 $((AFTER - BEFORE)) 个请求"
grep -q '本机桌面端' "$TMP/nofallback.err" && pass "stderr 指出来源是本机桌面端 profile" || fail "stderr 未指明连接来源"
grep -q 'desk' "$TMP/nofallback.err" && pass "stderr 打印 profile 名" || fail "stderr 未打印 profile 名"
grep -q -- "--allow-local-destructive" "$TMP/nofallback.err" && pass "stderr 给出放行方式（新 flag 名）" || fail "stderr 未给出放行方式"
grep -q -- '--allow-fallback-destructive' "$TMP/nofallback.err" && fail "stderr 出现旧 flag 名" || pass "stderr 不出现旧 flag 名"

echo "== 2) 显式放行后才会真的发请求 =="
BEFORE="$(request_count)"
"$BIN" -y --allow-local-destructive record clear-payload >/dev/null 2>"$TMP/allow.err"; RC=$?
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
grep -q 'desk' "$TMP/allow.err" && pass "放行时打印 profile 名与目标地址" || fail "放行时未打印 profile 名"

echo "== 3) --help 只出现新 flag 名 =="
if "$BIN" --help 2>&1 | grep -q -- '--allow-fallback-destructive'; then
  fail "--help 仍出现旧 flag 名 --allow-fallback-destructive"
else
  pass "--help 不出现旧 flag 名"
fi

echo ""
echo "失败项：$FAILED"
if [ "$FAILED" -ne 0 ]; then
  echo "结果：FAIL"
  exit 1
fi
echo "结果：PASS"
