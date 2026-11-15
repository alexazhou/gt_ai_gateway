#!/bin/bash
# 执行位守护：cli 脚本 + git 钩子。判据只此一份。
#
# 单一口径：CI（.github/workflows/test.yml 里 test-cli 的第 3 步）和本地
# script/githook/pre-commit 都调本脚本 —— 不要各自内联一份判据。
# 教训照抄 verify_versions.sh 那段注释：#269 时两处是两条分头写的表达，
# 等于两套判据，改一处漏一处没人发现。
#
# 两组对象：
#   A. cli/scripts/*.sh —— 交付给用户的命令脚本（`./x.sh` 会 permission denied）；
#   B. script/githook/* —— git 钩子。**钩子不可执行 = git 直接忽略它、根本不跑**，
#      也就是说 pre-commit 自己丢了 mode，本地这层守护当场不存在，而且不会有任何报错。
#      B 组只能靠 CI / 人手守：钩子守不了自己（它没被执行就没机会报错）。
#
# 判据：
#   1. 索引里的 mode 必须是 100755（查索引而非工作区：commit 记的是索引 mode，
#      「工作区 755 + 索引 644」照样提交成 644，这正是 #263/#266/#271 三次丢法的形态）；
#   2. 清单内每个名字必须存在，缺一个就红并把名字打出来；
#   3. 匹配到 0 个文件一律算失败（#271：旧断言在 0 匹配时打「ok: 0 个脚本」并 exit 0，
#      目录改名/整体删除会让守护静默变绿）；
#   4. 钩子组额外的文件（非 .md）也必须是 100755 —— 不可执行的钩子就是坏的，
#      所以这一组「多出来」也算失败，不像 A 组那样只提示。
#
# A 组清单为什么是「下限 + 白名单」：新增脚本不该被这个门拦住（否则加一个脚本要改两处
# 还卡一次 CI），但删除/改名必须红 —— 那通常不是有意为之，而是 #263/#266 那种顺手丢东西。
#
# 退出码：0 通过；1 不通过。

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR" || exit 1

CLI_EXPECTED=(
    build.sh
    e2e-config-path.sh
    e2e-fallback-destructive.sh
    e2e-shell-env.sh
    e2e.sh
    release.sh
)
HOOK_EXPECTED=(
    commit-msg
    pre-commit
)

FAILED=0

# ---- A 组：cli/scripts/*.sh ----
CLI_LISTING="$(git ls-files -s -- 'cli/scripts/*.sh')"
CLI_COUNT="$(printf '%s' "$CLI_LISTING" | grep -c . || true)"

if [ "${CLI_COUNT:-0}" -eq 0 ]; then
    echo "❌ cli/scripts/*.sh 匹配到 0 个文件。"
    echo "   这不是『没有脚本要检查』，而是 pathspec 失效了：目录被改名/移动/整体删除？"
    echo "   期望至少匹配到 ${#CLI_EXPECTED[@]} 个：${CLI_EXPECTED[*]}"
    FAILED=1
else
    CLI_BAD="$(printf '%s\n' "$CLI_LISTING" | awk '$1 != "100755" {print "  " $1 "  " $4}')"
    if [ -n "$CLI_BAD" ]; then
        echo "❌ 以下 cli/scripts/*.sh 在索引里的 mode 不是 100755："
        echo "$CLI_BAD"
        echo "   修复：chmod +x <文件> && git add <文件>（或 git update-index --chmod=+x <文件>）"
        FAILED=1
    fi
    CLI_MISSING=""
    for name in "${CLI_EXPECTED[@]}"; do
        if ! printf '%s\n' "$CLI_LISTING" | awk -v p="cli/scripts/$name" '$4 == p {found=1} END {exit found ? 0 : 1}'; then
            CLI_MISSING="$CLI_MISSING $name"
        fi
    done
    if [ -n "$CLI_MISSING" ]; then
        echo "❌ cli/scripts 清单里的脚本不见了（改名 / 误删？）："
        for name in $CLI_MISSING; do
            echo "  missing: cli/scripts/$name"
        done
        echo "   若是有意删除/改名，请同步更新本脚本的 CLI_EXPECTED 清单。"
        FAILED=1
    fi
fi

# ---- B 组：script/githook/*（钩子必须可执行，否则 git 静默不跑）----
HOOK_LISTING="$(git ls-files -s -- 'script/githook/*' | awk '$4 !~ /\.md$/')"
HOOK_COUNT="$(printf '%s' "$HOOK_LISTING" | grep -c . || true)"

if [ "${HOOK_COUNT:-0}" -eq 0 ]; then
    echo "❌ script/githook/* 匹配到 0 个文件（钩子目录被改名/删除？）"
    echo "   期望至少匹配到 ${#HOOK_EXPECTED[@]} 个：${HOOK_EXPECTED[*]}"
    FAILED=1
else
    HOOK_BAD="$(printf '%s\n' "$HOOK_LISTING" | awk '$1 != "100755" {print "  " $1 "  " $4}')"
    if [ -n "$HOOK_BAD" ]; then
        echo "❌ 以下 git 钩子的索引 mode 不是 100755 —— 不可执行的钩子会被 git 静默忽略，本地守护等于不存在："
        echo "$HOOK_BAD"
        echo "   修复：chmod +x <钩子> && git add <钩子>（或 git update-index --chmod=+x <钩子>）"
        FAILED=1
    fi
    HOOK_MISSING=""
    for name in "${HOOK_EXPECTED[@]}"; do
        if ! printf '%s\n' "$HOOK_LISTING" | awk -v p="script/githook/$name" '$4 == p {found=1} END {exit found ? 0 : 1}'; then
            HOOK_MISSING="$HOOK_MISSING $name"
        fi
    done
    if [ -n "$HOOK_MISSING" ]; then
        echo "❌ script/githook 清单里的钩子不见了（改名 / 误删？）："
        for name in $HOOK_MISSING; do
            echo "  missing: script/githook/$name"
        done
        echo "   若是有意删除/改名，请同步更新本脚本的 HOOK_EXPECTED 清单与 core.hooksPath 的配置说明。"
        FAILED=1
    fi
fi

if [ "$FAILED" -ne 0 ]; then
    exit 1
fi

# ---- 正向：报出可核对的数量 ----
echo "ok: cli/scripts 下 ${CLI_COUNT} 个 .sh 均为 100755（清单 ${#CLI_EXPECTED[@]} 个，全部存在）"
echo "ok: script/githook 下 ${HOOK_COUNT} 个钩子均为 100755（清单 ${#HOOK_EXPECTED[@]} 个，全部存在）"

EXTRA="$(printf '%s\n' "$CLI_LISTING" | awk '{print $4}' | while read -r p; do
    base="${p#cli/scripts/}"
    hit=0
    for name in "${CLI_EXPECTED[@]}"; do [ "$name" = "$base" ] && hit=1; done
    [ "$hit" -eq 0 ] && echo "  extra: $p"
done)"
if [ -n "$EXTRA" ]; then
    echo "提示：以下 .sh 不在清单内（不拦，但建议加进本脚本的 CLI_EXPECTED）："
    echo "$EXTRA"
fi

exit 0
