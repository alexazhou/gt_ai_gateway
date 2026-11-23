#!/usr/bin/env bash
# 构建 gtgw 单文件二进制（版本号从仓库根 package.json 注入）。
#
# 用法：
#   bash cli/scripts/build.sh                 # 本机 GOOS/GOARCH
#   GOOS=linux GOARCH=arm64 bash cli/scripts/build.sh
#   OUT=/tmp/gtgw bash cli/scripts/build.sh
#
# 说明（step2 §构建与版本注入）：
#   * 版本单一来源 = 仓库根 package.json 的 version；可用 GTGW_VERSION 显式覆盖（CI 传 tag 时用）。
#   * CGO_ENABLED=0 ⇒ 纯静态单文件，不依赖目标机 libc。
#   * -trimpath 去掉本机绝对路径；-buildvcs=false 让构建不依赖 .git（Docker 内没有 git）。
set -euo pipefail

CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$CLI_DIR/.." && pwd)"

GOOS_TARGET="${GOOS:-$(go env GOOS)}"
GOARCH_TARGET="${GOARCH:-$(go env GOARCH)}"
SUFFIX=""
if [ "$GOOS_TARGET" = "windows" ]; then
  SUFFIX=".exe"
fi
OUT="${OUT:-$CLI_DIR/dist/gtgw${SUFFIX}}"

# --- 版本：GTGW_VERSION > 根 package.json ---
VERSION="${GTGW_VERSION:-}"
if [ -z "$VERSION" ]; then
  VERSION="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO_ROOT/package.json" | head -1)"
fi
if [ -z "$VERSION" ]; then
  echo "[build] 无法从 $REPO_ROOT/package.json 读到 version（也不在 GTGW_VERSION 里）" >&2
  exit 1
fi

# --- commit：仓库里取短 sha；Docker 内没有 .git 时留空 ---
COMMIT="${GTGW_COMMIT:-}"
if [ -z "$COMMIT" ]; then
  COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || true)"
fi

LDFLAGS="-s -w -X main.version=${VERSION}"
if [ -n "$COMMIT" ]; then
  LDFLAGS="$LDFLAGS -X main.commit=${COMMIT}"
fi

echo "[build] go        = $(go version)"
echo "[build] target    = ${GOOS_TARGET}/${GOARCH_TARGET} (CGO_ENABLED=0)"
echo "[build] version   = ${VERSION}$([ -n "$COMMIT" ] && echo " (commit ${COMMIT})")"
echo "[build] ldflags   = \"${LDFLAGS}\""
echo "[build] output    = ${OUT}"

mkdir -p "$(dirname "$OUT")"
cd "$CLI_DIR"
CGO_ENABLED=0 GOOS="$GOOS_TARGET" GOARCH="$GOARCH_TARGET" \
  go build -trimpath -buildvcs=false -ldflags "$LDFLAGS" -o "$OUT" .

echo "[build] done: $(ls -l "$OUT" | awk '{print $5}') bytes"
