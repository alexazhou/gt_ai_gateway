#!/usr/bin/env bash
# 删除 Docker Hub 上 multi-arch 合并后遗留的平台后缀 tag（-amd64 / -arm64）
#
# Docker Hub 的 tag 删除接口不接受 Basic auth（一律返回 401），
# 必须先 POST /v2/users/login/ 用 用户名+token 换取 JWT，再以 Authorization: JWT 调用删除。
#
# 用法:
#   DOCKERHUB_USERNAME=<user> DOCKERHUB_TOKEN=<token> \
#     bash script/docker_hub_delete_platform_tags.sh "<tags...>"
#
# tags 参数为 docker/metadata-action 的 outputs.tags（完整镜像引用，空格分隔）；
# 其中 ghcr.io 条目会被跳过。脚本只删除「镜像名:name」中 -amd64/-arm64 后缀的 tag，
# 不打乱 multi-arch manifest 本体。

username="${DOCKERHUB_USERNAME:-}"
token="${DOCKERHUB_TOKEN:-}"
tags="${*:-}"

if [ -z "$username" ] || [ -z "$token" ]; then
  echo "::error::DOCKERHUB_USERNAME and DOCKERHUB_TOKEN are required" >&2
  exit 1
fi

if [ -z "$tags" ]; then
  echo "::warning::no tags provided, nothing to clean"
  exit 0
fi

# 登录换取 JWT（token 可当作密码用于 Hub API 认证）
jwt=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"${username}\",\"password\":\"${token}\"}" \
  "https://hub.docker.com/v2/users/login/" \
  | python3 -c "import json,sys;print(json.load(sys.stdin).get('token',''))" 2>/dev/null || true)

if [ -z "$jwt" ]; then
  echo "::warning::Failed to obtain Docker Hub JWT, skip platform tag cleanup"
  exit 0
fi
echo "obtained JWT (len=${#jwt})"

for tag in $tags; do
  case "$tag" in
    *"ghcr.io"*) echo "skip ghcr.io: $tag"; continue ;;
  esac
  tagname="${tag#*:}"
  for suffix in amd64 arm64; do
    code=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
      -H "Authorization: JWT ${jwt}" \
      "https://hub.docker.com/v2/repositories/${username}/gt_ai_gateway/tags/${tagname}-${suffix}/")
    echo "delete ${username}/gt_ai_gateway:${tagname}-${suffix} -> HTTP ${code}"
  done
done