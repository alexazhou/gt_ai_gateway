#!/usr/bin/env bash
# 四 shell 的 `gtgw integration env` 实测：语法检查 + 真 shell 里 eval 后用 env 读回。
#
#   bash cli/scripts/e2e-shell-env.sh [BIN]
#
# 为什么要有这个脚本：
#   判据 7 只要求「bash -n 可验 + fish/pwsh 说明验证方式」，验收时因为本机没装 fish/pwsh 只能做文本断言。
#   验收人 2026-11-15 明确要求：**在 CI 里补这两个 shell 的 eval 实测**。CI 的 ubuntu runner
#   自带 pwsh、可 apt 装 fish，所以这条要求落在 CI 里做，本地不强求。
#
# 依赖缺失时**直接失败**（退出码 3），不静默跳过：
#   这个脚本的语义就是「四 shell 都真的能用」，跳过等于把判据变成假绿。
#   若当前分支还没有 integration 命令（例如 P4 基于 P1 时），本脚本会以 3 退出，
#   CI 只在「P3 已合入」的分支上接它。
set -uo pipefail

CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${1:-${BIN:-$CLI_DIR/dist/gtgw}}"
FAILED=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass() { echo "  ok   $*"; }
fail() { echo "  FAIL $*"; FAILED=$((FAILED + 1)); }

if [ ! -x "$BIN" ]; then
  echo "[shell-env] 二进制不存在：$BIN" >&2
  exit 3
fi

# 依赖探测：没有 integration 命令就没有可测的东西 —— 明确失败，别假装通过。
# 注意**不能**用 `integration env --help` 探测：cobra 见到 --help 会打印 root help 并 exit 0，
# 于是「命令不存在」会被误判成「命令存在」（本脚本第一版就踩了这个坑）。
if ! "$BIN" --help 2>/dev/null | grep -qE '^  integration[[:space:]]'; then
  # 固定前缀 SKIP-REASON：验收人在 CI 日志里 grep 它，就能区分「依赖缺失 exit 3」与「断言失败 exit 1/2」。
  # 注意这不是 skip：本脚本以退出码 3 结束，CI 里该 job 会显示失败（红），不会被当成成功吞掉。
  echo "SKIP-REASON: 需要 P3 命令 \`gtgw integration env\`，当前树没有（feat/cli-p4 以 P1 为基点）" >&2
  echo "[shell-env] 这不是 skip：脚本存在的前提就是「四 shell 实测」，缺依赖时以 3 退出" >&2
  exit 3
fi

# 固定网关地址与 token，避免依赖本机配置；脚本只关心「导出的值对不对」
export GTGW_URL="http://127.0.0.1:18799"
export GTGW_TOKEN="sk-e2e-shell-env"

# 期望值（与 cmd/integration.go 的口径一致：OpenAI 用 /llm/v1，Anthropic 用 /llm）
WANT_OPENAI="$GTGW_URL/llm/v1"
WANT_ANTHROPIC="$GTGW_URL/llm"
WANT_KEY="$GTGW_TOKEN"

# check_env <shell> <4 行 "NAME=VALUE">：断言 4 个变量齐全且值正确
check_env() {
  local shell=$1 got=$2
  local name value
  for pair in "OPENAI_BASE_URL=$WANT_OPENAI" "OPENAI_API_KEY=$WANT_KEY" \
              "ANTHROPIC_BASE_URL=$WANT_ANTHROPIC" "ANTHROPIC_AUTH_TOKEN=$WANT_KEY"; do
    name="${pair%%=*}"
    value="${pair#*=}"
    if printf '%s\n' "$got" | grep -qx -- "$name=$value"; then
      pass "$shell: $name=$value"
    else
      fail "$shell: $name 期望 $value，实际 $(printf '%s\n' "$got" | grep -- "^$name=" || echo '<缺失>')"
    fi
  done
  local n
  n=$(printf '%s\n' "$got" | grep -cE '^(OPENAI|ANTHROPIC)_' || true)
  [ "$n" = "4" ] && pass "$shell: 恰好 4 个相关变量" || fail "$shell: 相关变量 $n 个（期望 4）"
}

echo "== bash =="
"$BIN" integration env --shell bash > "$TMP/env.bash" || fail "生成 bash 片段失败"
bash -n "$TMP/env.bash" && pass "bash -n 通过" || fail "bash -n 失败"
GOT=$(env -i bash -c "source '$TMP/env.bash'; env | grep -E '^(OPENAI|ANTHROPIC)_' | sort")
check_env bash "$GOT"

echo "== zsh =="
"$BIN" integration env --shell zsh > "$TMP/env.zsh" || fail "生成 zsh 片段失败"
if command -v zsh >/dev/null 2>&1; then
  zsh -n "$TMP/env.zsh" && pass "zsh -n 通过" || fail "zsh -n 失败"
  GOT=$(env -i zsh -c "source '$TMP/env.zsh'; env | grep -E '^(OPENAI|ANTHROPIC)_' | sort")
  check_env zsh "$GOT"
else
  fail "本机没有 zsh，无法实测（CI 的 ubuntu runner 自带，会跑到）"
fi

echo "== fish =="
"$BIN" integration env --shell fish > "$TMP/env.fish" || fail "生成 fish 片段失败"
if command -v fish >/dev/null 2>&1; then
  GOT=$(env -i fish -c "source '$TMP/env.fish'; env | grep -E '^(OPENAI|ANTHROPIC)_' | sort" 2>&1)
  check_env fish "$GOT"
else
  fail "本机没有 fish，无法实测（读法：sudo apt-get install -y fish）"
fi

echo "== powershell =="
"$BIN" integration env --shell powershell > "$TMP/env.ps1" || fail "生成 powershell 片段失败"
if command -v pwsh >/dev/null 2>&1; then
  GOT=$(env -i pwsh -NoProfile -NonInteractive -Command \
    ". '$TMP/env.ps1'; Get-ChildItem env: | Where-Object { \$_.Name -match '^(OPENAI|ANTHROPIC)_' } | ForEach-Object { \"\$(\$_.Name)=\$(\$_.Value)\" } | Sort-Object" 2>&1)
  check_env powershell "$GOT"
else
  fail "本机没有 pwsh，无法实测（GitHub ubuntu runner 自带 pwsh）"
fi

echo ""
echo "失败项：$FAILED"
if [ "$FAILED" -ne 0 ]; then
  echo "结果：FAIL"
  exit 1
fi
echo "结果：PASS"
