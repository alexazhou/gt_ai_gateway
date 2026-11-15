#!/bin/bash
#
# 安装 git hooks（版本一致性校验 + AI 署名拦截）。
#
# 为什么需要这个脚本：仓库里的钩子放在 `script/githook/`，但 **git 不会自动使用它**。
# 之前靠每个人手工 `ln -s ../../script/githook/pre-commit .git/hooks/pre-commit`，
# 新同事不知道、CI/新克隆也不会做 —— 结果钩子「看起来存在」但从不执行。
# 更隐蔽的一种失效：钩子文件**丢了可执行位**（100755 → 100644）时，git 会**静默跳过**
# 且不报错，校验等于不存在（#19 就是这么来的）。
#
# 用法：
#   bash script/install-githooks.sh     # 手工安装（幂等）
#   npm install                         # 由 package.json 的 prepare 自动调用
#
# 优先用 `core.hooksPath`（无符号链接、克隆后一条命令即可），失败时回退到符号链接。

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

HOOK_DIR="script/githook"
HOOK_FILE="$HOOK_DIR/pre-commit"
COMMIT_MSG_FILE="$HOOK_DIR/commit-msg"

if [ ! -f "$HOOK_FILE" ]; then
    echo "[githooks] 找不到 $HOOK_FILE，跳过"
    exit 0
fi

# 不在 git 仓库里（例如 CI 的某些阶段 / npm 包被安装到别处）就安静跳过，不要阻断安装
if ! git rev-parse --git-dir >/dev/null 2>&1; then
    echo "[githooks] 当前目录不是 git 仓库，跳过（仅提示，不报错）"
    exit 0
fi

# 1. 保证可执行位（工作区 + 索引都要），否则 git 会静默跳过钩子
for f in "$HOOK_FILE" "$COMMIT_MSG_FILE"; do
    chmod +x "$f" 2>/dev/null || true
    git update-index --chmod=+x "$f" >/dev/null 2>&1 || true
done

# 2. 首选 core.hooksPath（相对路径，随仓库走，不需要符号链接）
if git config core.hooksPath "$HOOK_DIR" 2>/dev/null; then
    echo "[githooks] 已配置 core.hooksPath = $HOOK_DIR"
    echo "[githooks] 生效钩子：$(git config core.hooksPath)/pre-commit（版本一致性） + $(git config core.hooksPath)/commit-msg（AI 署名拦截）"
    exit 0
fi

# 3. 回退：符号链接到 .git/hooks（老办法，仅当 hooksPath 配置失败时）
GIT_DIR="$(git rev-parse --git-common-dir)"
mkdir -p "$GIT_DIR/hooks"
ln -sf "$(pwd)/$HOOK_FILE" "$GIT_DIR/hooks/pre-commit"
ln -sf "$(pwd)/$COMMIT_MSG_FILE" "$GIT_DIR/hooks/commit-msg"
chmod +x "$GIT_DIR/hooks/pre-commit" 2>/dev/null || true
echo "[githooks] core.hooksPath 配置失败，已回退为符号链接：$GIT_DIR/hooks/pre-commit -> $(pwd)/$HOOK_FILE"
exit 0
