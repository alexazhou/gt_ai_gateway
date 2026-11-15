#!/bin/bash
# cli/scripts/*.sh 执行位守护。
#
# 单一口径：CI（.github/workflows/test.yml 里 test-cli 的第 3 步）和本地
# script/githook/pre-commit 都调本脚本 —— 不要各自内联一份判据。
# 教训照抄 verify_versions.sh 那段注释：#269 时两处是两条分头写的表达，
# 等于两套判据，改一处漏一处没人发现。#271 把它们收成一个文件。
#
# 判据三条：
#   1. 清单内每个 cli/scripts/*.sh 在**索引**里的 mode 必须是 100755
#      —— 查索引而不是工作区：commit 记的是索引里的 mode，
#         「工作区 755 + 索引 644」照样会提交成 644（#266 就是这么丢的）。
#   2. 清单内每个名字都必须存在；缺一个就红，并把缺的名字打出来。
#   3. **匹配到 0 个文件一律算失败**（#271）：旧断言在 pathspec 0 匹配时
#      打一行「ok: 0 个脚本均为 100755」然后 exit 0 —— 目录改名或整体删除
#      会让守护静默变绿，等于假守护。
#
# 清单为什么是「下限 + 白名单」而不是「精确集合」：
#   新增脚本不该被这个门拦住（否则加一个脚本要改两处还卡一次 CI）；
#   但**删除/改名必须红**——那通常不是有意为之，而是 #263/#266 那种顺手丢东西。
#   所以：清单内的名字缺了 ⇒ 红；清单外多出 .sh ⇒ 只提示，不拦。
#
# 退出码：0 通过；1 不通过。

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR" || exit 1

# 期望清单（下限）：cli/scripts 下的 .sh。新增脚本时可选地把名字加进来，
# 让「误删/改名」也能被这个门抓住；不加不影响通过。
EXPECTED=(
    build.sh
    e2e-config-path.sh
    e2e-fallback-destructive.sh
    e2e-shell-env.sh
    e2e.sh
    release.sh
)

LISTING="$(git ls-files -s -- 'cli/scripts/*.sh')"
COUNT="$(printf '%s' "$LISTING" | grep -c . || true)"

# 判据 3：0 匹配 = 失败（不是跳过）
if [ "${COUNT:-0}" -eq 0 ]; then
    echo "❌ cli/scripts/*.sh 匹配到 0 个文件。"
    echo "   这不是『没有脚本要检查』，而是 pathspec 失效了：目录被改名/移动/整体删除？"
    echo "   期望至少匹配到 ${#EXPECTED[@]} 个：${EXPECTED[*]}"
    exit 1
fi

FAILED=0

# 判据 1：索引 mode
MODE_BAD="$(printf '%s\n' "$LISTING" | awk '$1 != "100755" {print "  " $1 "  " $4}')"
if [ -n "$MODE_BAD" ]; then
    echo "❌ 以下 cli/scripts/*.sh 在索引里的 mode 不是 100755："
    echo "$MODE_BAD"
    echo "   修复：chmod +x <文件> && git add <文件>（或 git update-index --chmod=+x <文件>）"
    FAILED=1
fi

# 判据 2：清单内的名字必须存在
MISSING=""
for name in "${EXPECTED[@]}"; do
    if ! printf '%s\n' "$LISTING" | awk -v p="cli/scripts/$name" '$4 == p {found=1} END {exit found ? 0 : 1}'; then
        MISSING="$MISSING $name"
    fi
done
if [ -n "$MISSING" ]; then
    echo "❌ 清单里的脚本不见了（改名 / 误删？）："
    for name in $MISSING; do
        echo "  missing: cli/scripts/$name"
    done
    echo "   若是有意删除/改名，请同步更新本脚本的 EXPECTED 清单（script/check_cli_script_modes.sh）。"
    FAILED=1
fi

if [ "$FAILED" -ne 0 ]; then
    exit 1
fi

# 正向：报出可核对的数量；清单外多出来的只提示
echo "ok: cli/scripts 下 ${COUNT} 个 .sh 均为 100755（清单 ${#EXPECTED[@]} 个，全部存在）"
EXTRA="$(printf '%s\n' "$LISTING" | awk '{print $4}' | while read -r p; do
    base="${p#cli/scripts/}"
    hit=0
    for name in "${EXPECTED[@]}"; do [ "$name" = "$base" ] && hit=1; done
    [ "$hit" -eq 0 ] && echo "  extra: $p"
done)"
if [ -n "$EXTRA" ]; then
    echo "提示：以下 .sh 不在清单内（不拦，但建议加进 script/check_cli_script_modes.sh 的 EXPECTED）："
    echo "$EXTRA"
fi

exit 0
