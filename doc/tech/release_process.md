# 新版本发布流程

## 目标

本文档用于记录本项目发布一个新版本时需要修改的文件、建议的校验动作，以及标准的提交流程。

适用场景：

- 发布正式版本，例如 `v1.3.3`
- 需要同步更新页面展示版本号
- 需要打 git tag 并推送到远端

## 需要修改的地方

发布新版本时，至少要同步以下版本号：

### 1. 根目录版本号

文件：

- `package.json`
- `package-lock.json`

需要修改为目标版本，例如：

```json
"version": "1.3.3"
```

说明：

- 后端系统状态接口会读取根目录 `package.json` 的版本号
- 页面左下角版本号、仪表盘系统信息中的版本号，最终都依赖这里

### 2. 前端包版本号

文件：

- `frontend/package.json`
- `frontend/package-lock.json`

需要修改为同一个目标版本，例如：

```json
"version": "1.3.3"
```

说明：

- 虽然当前页面显示主要取后端版本，但前端包本身也应保持一致
- 避免后续构建、排查、制品追踪时出现版本不一致

## 建议发布前检查

发布前至少执行以下检查：

### 1. 前端构建

```bash
cd frontend
npm run build
```

目的：

- 确认 Vue 模板、TS 类型、样式改动没有破坏构建

### 2. 关键后端测试

如果本次改动涉及接口逻辑，至少补跑相关测试。比如统计接口：

```bash
TEST_REAL_API=true npx vitest run tests/api/stats/stats.test.ts --config vitest.config.ts
```

原则：

- 不要求每次全量回归
- 但必须覆盖本次改动影响到的关键链路

## 标准发布步骤

以下以发布 `v1.3.3` 为例。

### 1. 修改版本号

更新以下文件：

- `package.json`
- `package-lock.json`
- `frontend/package.json`
- `frontend/package-lock.json`

### 2. 执行验证

至少执行：

```bash
cd frontend
npm run build
```

如果包含后端逻辑改动，再补充对应测试。

### 3. 查看工作区，确认只提交目标文件

```bash
git status --short
```

注意：

- 工作区可能存在本地调试文件、数据库、日志目录、个人配置文件
- 只把本次发布相关文件加入暂存区，不要误提交无关内容

### 4. 暂存发布相关文件

示例：

```bash
git add package.json package-lock.json frontend/package.json frontend/package-lock.json
```

如果本次还包含功能改动或 UI 修复，则把对应源码文件一起加入。

### 5. 提交 commit

示例：

```bash
git commit -m "Polish dashboard layout and bump v1.3.3"
```

commit message 原则：

- 简洁说明本次主要改动
- 如果是纯版本发布，也可以使用明确的 release message

### 6. 打 tag

示例：

```bash
git tag v1.3.3
```

约定：

- tag 使用 `v` 前缀
- tag 名与版本号保持一致

### 7. 推送 commit 和 tag

```bash
git push origin master
git push origin v1.3.3
```

如果项目分支策略调整，则把 `master` 替换为实际发布分支。

## 发布后验证

发布完成后建议做两类确认：

### 1. 代码仓库确认

检查：

- 目标 commit 是否已推送到远端
- tag 是否已出现在远端仓库

### 2. 页面确认

启动服务后检查：

- 左下角版本号是否更新
- 仪表盘系统信息中的版本号是否更新
- 本次发布涉及的页面改动是否生效

## 常见注意事项

### 1. 不要只改一个 package.json

如果只改根目录版本号，而不改前端版本号，后续排查时容易出现版本混乱。

### 2. 不要把无关本地文件一起提交

例如：

- `local.db`
- `log/`
- `.claude/`
- `.gemini/`

这些通常属于本地环境文件，不应混入正式发布提交。

### 3. 打 tag 前先确认 commit 已正确生成

推荐顺序必须是：

1. 修改并提交
2. 基于该 commit 打 tag
3. 推送 commit
4. 推送 tag

不要在未提交代码时直接打 tag。

## 当前版本实践

以 `v1.3.3` 这次发布为例，实际包含了：

- 仪表盘系统状态卡片高度对齐
- 系统信息区域结构简化
- 根目录与前端版本号同步更新到 `1.3.3`
- 创建并推送 tag `v1.3.3`

后续发布可直接参考本文档执行。
