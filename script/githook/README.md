# git hooks（`script/githook/`）

本目录下的两个钩子：

**`pre-commit` —— 版本号一致性校验** —— 直接调用 `script/verify_versions.sh`（与 CI 的 `Verify Version Consistency` 同一套规则，覆盖 9 个文件 / 12 处，含 `tauri/src-tauri/Cargo.lock` 与 lockfile 的 `packages[""].version` 副本）；
**`commit-msg` —— AI 署名拦截**：提交信息里出现 `claude` 等字样时拒绝提交。

> 为什么分成两个：git 只对 `commit-msg` 钩子传「信息文件路径」(`$1`)，这是唯一可靠的获取方式。原先在 `pre-commit` 里读 `.git/COMMIT_MSG` 恒不存在（git 实际写的是 `COMMIT_EDITMSG`），那段检查**从未执行过**却被文档描述成「会拦截」—— 与 P2-14、#18 同一病根。

## 安装

```bash
npm install                      # package.json 的 prepare 会自动调用下面的脚本
# 或者手工：
bash script/install-githooks.sh
```

脚本做三件事，幂等：

- 给 `script/githook/pre-commit`、`script/githook/commit-msg` 补可执行位（工作区 + 索引都改，即 `100755`）；
- 配置 `git config core.hooksPath script/githook`（**首选**：不需要符号链接，克隆后一条命令即可生效）；
- 若 `core.hooksPath` 配置失败，回退为把 `.git/hooks/pre-commit` 指向本目录的符号链接。

## 为什么需要安装脚本（两条真实踩坑）

1. **钩子放着不等于生效**：文件放在 `script/githook/` 时，git 默认根本不读它。之前靠每人手工建符号链接，新同事不知道 → 校验「看起来有」但从没跑过。
2. **丢了可执行位会静默跳过**：`100755 → 100644` 之后 git **不报错、直接跳过**钩子。曾因此让版本校验和 AI 署名拦截**双双失效且无任何提示**（#19）。所以安装脚本会显式 `chmod +x` + `git update-index --chmod=+x`，提交前也可自查：
   ```bash
   git ls-files -s script/githook/pre-commit     # 必须是 100755
   ```

## 自查

```bash
bash script/install-githooks.sh        # 安装/修复
git ls-files -s script/githook/pre-commit   # 期望 100755
git config core.hooksPath                   # 期望 script/githook
bash script/githook/pre-commit              # 直接跑一遍，期望 exit 0
echo "x" > /tmp/m && bash script/githook/commit-msg /tmp/m   # 期望 exit 0（不含 AI 署名）
```

## 绕过（仅在明确知道后果时）

```bash
git commit --no-verify
```

**不要**用它绕过版本号不一致 —— CI 的 `Verify Version Consistency` 会再拦一次，绕过本地钩子只会把失败推到更晚、更难查的位置。
