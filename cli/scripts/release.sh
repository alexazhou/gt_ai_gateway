#!/usr/bin/env bash
# 交叉编译 gtgw 的发布产物（6 个目标）+ 生成 sha256 清单。
#
# 用法：
#   bash cli/scripts/release.sh                 # 输出到 cli/dist/cli/
#   OUT_DIR=/tmp/rel bash cli/scripts/release.sh
#   TARGETS="darwin/arm64 linux/amd64" bash cli/scripts/release.sh
#
# 产物命名与 release 里其它资产一致：gtgw_cli_<version>_<os>_<arch>[.exe]
# 每个目标都走 cli/scripts/build.sh，因此 CGO_ENABLED=0 / -trimpath / ldflags 注入只有一处实现。
set -euo pipefail

CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$CLI_DIR/.." && pwd)"
OUT_DIR="${OUT_DIR:-$CLI_DIR/dist/cli}"

# 默认 6 个目标：macOS / Linux / Windows × amd64 / arm64
DEFAULT_TARGETS="darwin/amd64 darwin/arm64 linux/amd64 linux/arm64 windows/amd64 windows/arm64"
TARGETS="${TARGETS:-$DEFAULT_TARGETS}"

VERSION="${GTGW_VERSION:-$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO_ROOT/package.json" | head -1)}"
if [ -z "$VERSION" ]; then
  echo "[release] 无法确定 version（package.json / GTGW_VERSION）" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
echo "[release] version = $VERSION"
echo "[release] out     = $OUT_DIR"

for target in $TARGETS; do
  os="${target%%/*}"
  arch="${target##*/}"
  suffix=""
  [ "$os" = "windows" ] && suffix=".exe"
  out="$OUT_DIR/gtgw_cli_${VERSION}_${os}_${arch}${suffix}"
  echo ""
  GOOS="$os" GOARCH="$arch" OUT="$out" GTGW_VERSION="$VERSION" bash "$CLI_DIR/scripts/build.sh"
done

echo ""
echo "[release] sha256:"
cd "$OUT_DIR"
: > "gtgw_cli_${VERSION}_sha256sums.txt"
for f in gtgw_cli_*; do
  case "$f" in
    *sha256sums.txt) continue ;;
  esac
  sha256sum "$f" >> "gtgw_cli_${VERSION}_sha256sums.txt" 2>/dev/null || shasum -a 256 "$f" >> "gtgw_cli_${VERSION}_sha256sums.txt"
done
cat "gtgw_cli_${VERSION}_sha256sums.txt"

echo ""
echo "[release] 产物清单:"
ls -l "$OUT_DIR" | grep gtgw_cli_ || true
