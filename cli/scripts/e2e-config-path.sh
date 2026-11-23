#!/usr/bin/env bash
# 配置目录 e2e：验证 `~/.gtgw/config.json` 是唯一落盘位置，且旧路径 `~/.config/gtgw/config.json`
# **不被读取**（2026-11-15 需求：不做双读、不做静默兼容）。
#
#   bash cli/scripts/e2e-config-path.sh [BIN]
#
# 覆盖三条：
#   1. 全新环境 `login --url <mock>` ⇒ 文件落在 `$HOME/.gtgw/config.json`，目录 0700 / 文件 0600；
#   2. 旧路径放一份「假 profile」、`$HOME/.gtgw` 不存在 ⇒ `status` 必须报「没有可用的网关地址」，
#      且服务端零请求（证明没读到旧文件）；
#   3. 全程只碰临时 HOME，真实家目录不被创建/改写（脚本自己校验 `$REAL_HOME`）。
# 依赖：无（只用 login / status / profile list）。
set -uo pipefail

CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${1:-${BIN:-$CLI_DIR/dist/gtgw}}"
TOKEN="sk-abcdefghijkl"
FAILED=0

pass() { echo "  ok   $*"; }
fail() { echo "  FAIL $*"; FAILED=$((FAILED + 1)); }

if [ ! -x "$BIN" ]; then
  echo "[config-path-e2e] 二进制不存在：$BIN" >&2
  exit 3
fi

free_port() {
  python3 - <<'PY'
import socket
s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()
PY
}

REAL_HOME="${HOME:-}"
TMP="$(mktemp -d)"
PORT="$(free_port)"
python3 "$CLI_DIR/scripts/mock_gateway.py" "$PORT" "$TMP/mock.log" &
MOCK_PID=$!
trap 'kill -9 "$MOCK_PID" 2>/dev/null; rm -rf "$TMP"' EXIT

for _ in $(seq 1 100); do
  if python3 -c "import socket,sys;socket.create_connection(('127.0.0.1',$PORT),timeout=0.2)" 2>/dev/null; then break; fi
  sleep 0.1
done
MOCK="http://127.0.0.1:$PORT"
request_count() { if [ -f "$TMP/mock.log" ]; then wc -l < "$TMP/mock.log" | tr -d ' '; else echo 0; fi; }

export HOME="$TMP/home"
export USERPROFILE="$TMP/home"
mkdir -p "$HOME"
unset GTGW_URL GTGW_TOKEN GTGW_TENANT GTGW_PROFILE GTGW_TAURI_CONFIG

echo "== 1) 全新环境 login 落到 \$HOME/.gtgw/config.json =="
"$BIN" login --url "$MOCK" --token "$TOKEN" >"$TMP/login.out" 2>"$TMP/login.err"; RC=$?
[ "$RC" = "0" ] && pass "login exit=0" || fail "login exit=$RC：$(cat "$TMP/login.err")"
ls -ld "$HOME/.gtgw" | sed 's/^/      /'
ls -l "$HOME/.gtgw/config.json" | sed 's/^/      /'
[ -f "$HOME/.gtgw/config.json" ] && pass "配置在 \$HOME/.gtgw/config.json" || fail "配置不在 \$HOME/.gtgw/config.json"
[ -f "$HOME/.config/gtgw/config.json" ] && fail "居然写出了旧路径" || pass "没有创建旧路径 \$HOME/.config/gtgw"

# 权限读数用 python3 取（macOS 的 `stat -f '%Lp'` 与 GNU 的 `stat -c '%a'` 互不兼容；
# CI 是 Linux、开发机是 macOS，靠 `stat || stat` 兜底会在 GNU 上先输出文件系统信息再回退，
# 得到「看起来像 700 其实带着垃圾前缀」的字符串 —— #266 接进 CI 时改掉的正是这个坑）。
perm_of() { python3 -c 'import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777)[2:])' "$1"; }

DIR_PERM="$(perm_of "$HOME/.gtgw")"
FILE_PERM="$(perm_of "$HOME/.gtgw/config.json")"
[ "$DIR_PERM" = "700" ] && pass "目录权限 0700" || fail "目录权限 $DIR_PERM（期望 700）"
[ "$FILE_PERM" = "600" ] && pass "文件权限 0600" || fail "文件权限 $FILE_PERM（期望 600）"

echo "== 1.1) status 读到的就是这份配置 =="
"$BIN" status --json >/dev/null 2>&1 && pass "status exit=0（能连上 mock）" || fail "status 失败"
"$BIN" profile list 2>/dev/null | sed 's/^/      /'

echo "== 2) 旧路径不被读取：只有 \$HOME/.config/gtgw/config.json 时 status 必须报没有地址 =="
rm -rf "$HOME/.gtgw"
mkdir -p "$HOME/.config/gtgw"
cat > "$HOME/.config/gtgw/config.json" <<EOF
{"active_profile":"legacy","profiles":{"legacy":{"base_url":"$MOCK","token":"$TOKEN"}}}
EOF
chmod 700 "$HOME/.config/gtgw"; chmod 600 "$HOME/.config/gtgw/config.json"
ls -l "$HOME/.config/gtgw/config.json" | sed 's/^/      /'

BEFORE="$(request_count)"
"$BIN" status >"$TMP/legacy.out" 2>"$TMP/legacy.err"; RC=$?
AFTER="$(request_count)"
echo "  exit=$RC，请求数 $BEFORE→$AFTER"
sed 's/^/      stderr: /' "$TMP/legacy.err" | head -3
[ "$RC" = "2" ] && pass "status exit=2（参数/用法错误）" || fail "status exit=$RC（期望 2）"
grep -q '没有可用的网关地址' "$TMP/legacy.err" && pass "报「没有可用的网关地址」" || fail "错误文案不含「没有可用的网关地址」"
[ "$BEFORE" = "$AFTER" ] && pass "零请求（旧配置没生效）" || fail "居然发了 $((AFTER - BEFORE)) 个请求（旧路径被读到了）"
[ -f "$HOME/.config/gtgw/config.json" ] && pass "旧文件未被改写" || fail "旧文件被删/被改"
[ -f "$HOME/.gtgw/config.json" ] && fail "读旧配置时又写了新路径" || pass "没有偷偷创建 \$HOME/.gtgw"

echo "== 3) 真实家目录未被碰过 =="
if [ -n "$REAL_HOME" ] && [ "$REAL_HOME" != "$HOME" ]; then
  if [ -e "$REAL_HOME/.gtgw" ]; then
    fail "真实家目录 $REAL_HOME/.gtgw 存在（可能是本次 e2e 创建，也可能本来就有：需人工确认）"
  else
    pass "真实家目录 $REAL_HOME/.gtgw 未被创建"
  fi
else
  echo "  skip 无法确定真实家目录"
fi

echo ""
echo "失败项：$FAILED"
if [ "$FAILED" -ne 0 ]; then
  echo "结果：FAIL"
  exit 1
fi
echo "结果：PASS"
