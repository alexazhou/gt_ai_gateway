# 目标描述

新增一种“直连官方” (OFFICIAL) 的连接模式，与现有的网关模式 (GATEWAY) 和供应商代理模式 (VENDOR) 并列。这允许用户将他们的 AI 客户端配置为直接连接官方上游（如 OpenAI 或 Anthropic），而不经过网关代理或第三方供应商。

## 需要确认的设计细节

- **数据解析与默认 URL**：在直连官方模式下，由于客户端直接连接官方服务器，当 `gatewayUrl` 为空时，我们将采用官方默认的端点：
  - Claude Code: `https://api.anthropic.com`
  - Codex: `https://api.openai.com`

- **关于直连官方的配置方式（方案 A）**：完全采用客户端原生的直连配置方式（例如为 Codex 设置 `model_provider = "openai"` 并写入原生密钥；为 Claude 省略 `ANTHROPIC_BASE_URL` 环境变量）。这种做法兼容性最好，真正做到“原汁原味”。

## 实施方案

---

### 后端常量与类型调整
修改核心的枚举和常量，以支持新模式。

#### [MODIFY] `src/constants.ts`
- 在 `ConnectionMode` 枚举中新增 `OFFICIAL = "official"`。

#### [MODIFY] `src/model/sgClientConfig.ts`
- 确保 TypeScript 类型推导正确支持新的 `ConnectionMode`。

---

### 后端适配器 (Adapters) 修改
更新适配器逻辑，以便正确解析和写入官方模式的配置文件。

#### [MODIFY] `src/service/clientConfigService/claudeCodeConfigAdapter.ts`
- 更新 `parseConfigFileContent`：如果在本地配置中 `backendUrl` 为空，或者等于 `https://api.anthropic.com`，则将其反向识别为 `ConnectionMode.OFFICIAL` 模式。
- 更新 `patchConfigFileContent`：当下发的 `connectionMode` 为 `OFFICIAL` 时，写入配置文件时不再注入 `ANTHROPIC_BASE_URL`，完全由客户端原生机制处理。

#### [MODIFY] `src/service/clientConfigService/codexConfigAdapter.ts`
- 更新 `parseConfigFileContent`：识别客户端原生的官方配置结构（例如 `model_provider = "openai"`），并将其解析为 `ConnectionMode.OFFICIAL`。
- 更新 `patchConfigFileContent`：当下发的 `connectionMode` 为 `OFFICIAL` 时，不再将其伪装成自定义服务，而是直接将 `model_provider` 设回 `openai`，并在对应的位置写入用户的原生 API Key 配置。

---

### 前端配置与界面
更新前端的类型定义和 UI 组件，让用户可以选择该模式。

#### [MODIFY] `frontend/src/types/clientConfig.ts`
- 在 `ClientConnectionMode` 中新增 `OFFICIAL: 'official'`。

#### [MODIFY] `frontend/src/views/ClientManager.vue`
- **UI 标签与图标设计**：在配置列表中，当识别到该配置为 `OFFICIAL` 模式时：
  - 展示专属的标签：`<a-tag>直连官方</a-tag>`（设定专属配色）。
  - 展示专属的图标流（emoji）：`🤖 ➔ 🏢`（代表从机器直接连到官方厂商）。
- **新建配置交互**：在“新建/修改配置”面板的“直连官方”标签页中，不提供手动填写表单，而是**展示引导提示**：
  > “提示：如需直连官方，请先通过客户端原生方式完成登录（例如在终端执行 `claude login` 或在 Cursor 中登录账号），然后直接点击下方的**『从本地文件提取』**即可导入配置。”
- **查看与编辑限制**：当用户通过点击列表里的“笔”图标进入一个**已经存在的**直连官方配置详情时：
  - 可以查看到提取出来的 `API Key` 和 `模型`。
  - **表单强制设为只读（或者禁用保存/更新按钮）**，因为直连官方的配置不允许通过本系统的 Web 界面来篡改和更新，只能从本地提取。

## 验证计划

### 自动化测试
- 运行 `npm run backend:test:type` 和 `npm run backend:test` 确保后端类型检查和适配器逻辑解析全部通过。
- 运行 `npm run frontend:build` 确保前端构建成功，无语法错误。

### 人工验证
- 本地启动前后端服务。
- 验证“直连官方”专属 Emoji 和标签的展示。
- 验证点击官方配置时，界面是只读状态无法点击保存。
- 模拟执行本地登录并点击“从本地提取”，验证系统能否正确识别其为“直连官方”模式并入库。
