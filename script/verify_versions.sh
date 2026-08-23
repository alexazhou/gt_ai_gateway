#!/bin/bash

v1=$(jq -r '.version' package.json)
v2=$(jq -r '.version' package-lock.json)
v3=$(jq -r '.version' frontend/package.json)
v4=$(jq -r '.version' frontend/package-lock.json)
v5=$(jq -r '.version' tauri/package.json)
v6=$(jq -r '.version' tauri/package-lock.json)
v7=$(jq -r '.version' tauri/src-tauri/tauri.conf.json)
v8=$(grep '^version' tauri/src-tauri/Cargo.toml | head -1 | sed 's/.*"\(.*\)"/\1/')

echo "Root version:        $v1"
echo "Root lock:           $v2"
echo "Frontend version:    $v3"
echo "Frontend lock:       $v4"
echo "Tauri version:       $v5"
echo "Tauri lock:          $v6"
echo "Tauri conf:          $v7"
echo "Cargo.toml:          $v8"

# 与 script/githook/pre-commit 保持同一套校验口径：所有版本号必须一致
if [ "$v1" != "$v2" ] || [ "$v1" != "$v3" ] || [ "$v3" != "$v4" ] || \
   [ "$v1" != "$v5" ] || [ "$v5" != "$v6" ] || [ "$v1" != "$v7" ] || [ "$v1" != "$v8" ]; then
  echo "❌ Version numbers are NOT consistent across all files!"
  exit 1
fi

echo "✅ All version numbers are consistent: $v1"