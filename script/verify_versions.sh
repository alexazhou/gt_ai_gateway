#!/bin/bash
#
# 版本号一致性校验 —— 唯一口径。
#
# 调用方（三者共用同一套判定，不要再各写一份）：
#   1. CI：.github/workflows/docker.yml、.github/workflows/tauri.yml
#   2. 本地：script/githook/pre-commit（提交时自动跑）
#   3. 手工：bash script/verify_versions.sh
#
# 覆盖范围（9 个文件 / 12 处）：
#   package.json                            (1)
#   package-lock.json                       (2: 根 version + packages[""].version)
#   frontend/package.json                   (1)
#   frontend/package-lock.json              (2)
#   tauri/package.json                      (1)
#   tauri/package-lock.json                 (2)
#   tauri/src-tauri/tauri.conf.json         (1)
#   tauri/src-tauri/Cargo.toml              (1)
#   tauri/src-tauri/Cargo.lock              (1)  <- 之前漏了这个
#
# 历史坑（P2 之后新增本文件覆盖）：早期脚本不检查 Cargo.lock，导致「脚本全绿 ≠ 已改全」：
# 漏改时 CI/本地都通过，但 Rust 构建一跑 cargo 会自己改写 Cargo.lock，
# 结果要么多出一处未提交 diff，要么出现「tag 是 beta2、锁文件里还是 beta1」。

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

fail=0
checked=()

# jq 取 JSON 顶层 version
json_version() { jq -r '.version // empty' "$1" 2>/dev/null; }

# jq 取 lockfile 里 packages[""].version（npm 会与顶层 version 同步，但两者都可能被手改）
json_root_pkg_version() { jq -r '.packages[""].version // empty' "$1" 2>/dev/null; }

# Cargo.toml 的 [package] version
toml_version() { grep -m1 '^version' "$1" 2>/dev/null | sed 's/.*"\(.*\)".*/\1/'; }

# Cargo.toml 的包名，用来在 Cargo.lock 里定位本包（避免误取依赖的 version）
toml_package_name() {
    awk '/^\[package\]/{inb=1; next} inb && $1=="name" && $2=="=" {gsub(/"/,"",$3); print $3; exit}' "$1"
}

# Cargo.lock 中本包（按 [[package]] 块 + name 匹配）的 version
cargo_lock_version() {
    local lock="$1" pkg="$2"
    awk -v pkg="$pkg" '
        /^\[\[package\]\]/ { name=""; next }
        $1=="name" && $2=="=" { n=$3; gsub(/"/,"",n); name=n; next }
        $1=="version" && $2=="=" && name==pkg { v=$3; gsub(/"/,"",v); print v; exit }
    ' "$lock" 2>/dev/null
}

check() {
    local label="$1" actual="$2"
    checked+=("$label")
    if [ -z "$actual" ]; then
        echo "❌ $label: 取不到版本号（文件缺失或格式变化）"
        fail=1
    elif [ "$actual" != "$EXPECTED" ]; then
        echo "❌ $label: $actual（应为 $EXPECTED）"
        fail=1
    else
        echo "✅ $label: $actual"
    fi
}

EXPECTED="$(json_version package.json)"
if [ -z "$EXPECTED" ]; then
    echo "❌ 无法从 package.json 读取 version，中止"
    exit 1
fi

echo "版本号基准（package.json）= $EXPECTED"
echo "---- 已校验 ----"

check "package.json"                        "$(json_version package.json)"
check "package-lock.json"                   "$(json_version package-lock.json)"
check "package-lock.json → packages[\"\"]"   "$(json_root_pkg_version package-lock.json)"
check "frontend/package.json"               "$(json_version frontend/package.json)"
check "frontend/package-lock.json"          "$(json_version frontend/package-lock.json)"
check "frontend/package-lock.json → packages[\"\"]"  "$(json_root_pkg_version frontend/package-lock.json)"
check "tauri/package.json"                  "$(json_version tauri/package.json)"
check "tauri/package-lock.json"             "$(json_version tauri/package-lock.json)"
check "tauri/package-lock.json → packages[\"\"]"     "$(json_root_pkg_version tauri/package-lock.json)"
check "tauri/src-tauri/tauri.conf.json"     "$(json_version tauri/src-tauri/tauri.conf.json)"
check "tauri/src-tauri/Cargo.toml"          "$(toml_version tauri/src-tauri/Cargo.toml)"

CARGO_PKG_NAME="$(toml_package_name tauri/src-tauri/Cargo.toml)"
if [ -z "$CARGO_PKG_NAME" ]; then
    echo "❌ 无法从 Cargo.toml 读取包名，无法校验 Cargo.lock"
    fail=1
else
    check "tauri/src-tauri/Cargo.lock (包 $CARGO_PKG_NAME)" "$(cargo_lock_version tauri/src-tauri/Cargo.lock "$CARGO_PKG_NAME")"
fi

echo "---- 统计 ----"
echo "已校验文件 9 个 / 版本号 12 处（共 ${#checked[@]} 项断言，含 lockfile 的 packages[\"\"] 副本）"

echo "---- 未覆盖（有意为之，别当成漏检）----"
echo "· 文档/评审稿里提到的版本号（doc/**、reviews/**）：随发布说明人工维护，不做机检"
echo "· git tag 与远端 tag：由 CI 的 tag 触发条件校验，不在本脚本范围"
echo "· 其它 lock 文件（如 ruff/uv 等，本项目暂无）：新增包管理器时请同步加入上面的 check 列表"

if [ "$fail" -ne 0 ]; then
    echo ""
    echo "❌ 版本号不一致：请把上述文件统一为目标版本后再提交/发布"
    echo "   提示：npm 类文件用 npm version <ver> --no-git-tag-version 同步；Cargo.lock 在 Cargo.toml 改完后跑一次 cargo check/metadata 生成"
    exit 1
fi

echo ""
echo "✅ 全部一致：$EXPECTED"
exit 0
