# Cloudflare Workers 自动部署文档

本项目原生支持部署到 Cloudflare Workers，享受边缘计算带来的低延迟、高可用和零服务器维护成本。数据持久化采用 Cloudflare D1 数据库，请求/响应记录的原始载荷则存放在 Cloudflare R2 对象存储中（与 D1 分离，避免大文本拖累数据库查询）。

---

## GitHub Actions 自动化部署 (推荐)

为了保证您未来能够无损、顺畅地获取项目更新，我们强烈建议您通过 GitHub Actions 进行自动化部署。此方案会自动为您完成 D1 数据库创建、R2 对象存储桶创建、表结构初始化以及代码发布。

### 第一步：Fork 本项目
请先点击页面右上角的 **Fork** 按钮，将本项目克隆到您自己的 GitHub 账号下。**这是后续能够享受一键自动升级的前提条件！**

<img src="../../images/do_fork.png" width="50%" alt="Fork 本项目">

### 第二步：获取 Cloudflare 部署凭证 (环境变量)
您需要准备两个 Cloudflare 凭证，以便 GitHub Actions 能够替您自动部署。获取方法非常简单：

1. **获取 Account ID**：
   - 登录 [Cloudflare 后台](https://dash.cloudflare.com/?to=/:account/workers-and-pages)，点击左侧菜单的 `Workers & Pages`。
   - 此时观察浏览器上方的地址栏 URL，格式通常为：`https://dash.cloudflare.com/一串由字母和数字组成的32位长字符/workers-and-pages`。
   - **这串 32 位的长字符**，就是您的 `Account ID`。复制下来备用。
   - *(或者您可以在页面右侧边栏下拉寻找 `Account ID` 并点击复制)*。

<img src="../../images/get_cloudflare_account_id.png" width="50%" alt="获取 Account ID">

2. **获取 API Token**：
   - 直接点击专属快捷链接前往 API 令牌管理页：[https://dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
   - 点击右侧的 `Create Token` (创建令牌) 按钮，拉到最下方选择 `Create Custom Token` (创建自定义令牌)。
   
   第一步

   <img src="../../images/create_token_step_1.png" width="50%" alt="创建自定义令牌">
   
   第二步

   <img src="../../images/create_token_step_2.png" width="50%" alt="创建自定义令牌">

   - **Token 名称 (Token name)**：随便填，比如 `GitHub Actions Deploy`。
   
   - **权限配置 (Permissions)**：点击 `Add more`，确保完整添加以下 **四项** 权限：
     - `Account` (帐户) | `D1` | `Edit` (编辑)
     - `Account` (帐户) | `Worker Scripts` (Worker 脚本) | `Edit` (编辑)
     - `Account` (帐户) | `Workers KV Storage` (Workers KV 存储) | `Edit` (编辑)
     - `Account` (帐户) | `Workers R2 Storage` (Workers R2 存储) | `Edit` (编辑)
   - 其它选项保持默认，拉到最下面点击 `Continue to summary`，然后点击 `Create Token`。
   - ⚠️ **核心警告**：此时屏幕上会显示出这串 Token 密钥，**它只显示这一次！刷新就会永远消失！** 请务必立刻将它复制下来备用。

   <img src="../../images/set_token_permissions.png" width="50%" alt="配置 Token 权限">

### 第三步：配置 GitHub Secrets
回到您刚才 Fork 的 GitHub 仓库页面：
1. 点击顶部的 `Settings` -> 左侧菜单的 `Secrets and variables` -> `Actions`。
2. 点击 `New repository secret`，添加以下两个 Secret：
   - Name: `CLOUDFLARE_ACCOUNT_ID`，Value 填入您刚才复制的 Account ID。
   - Name: `CLOUDFLARE_API_TOKEN`，Value 填入您刚才生成的 API Token。
   - Name: `ROOT_TOKEN`，请填入您自定义的后台管理员密码。

<img src="../../images/set_github_action_secret.png" width="50%" alt="配置 GitHub Secrets">

### 第四步：触发自动部署
1. 点击仓库顶部的 `Actions` 标签页。
2. 在左侧列表中选择 `Deploy to Cloudflare` 工作流。
3. 如果看到 "Workflows aren't being run on this forked repository"，请点击绿色的 `I understand my workflows, go ahead and enable them` 按钮。
4. 点击右侧的 `Run workflow` 按钮并确认执行。
5. 脚本会自动完成 D1 数据库创建/绑定、R2 对象存储桶创建、表结构迁移和代码发布（约耗时 1~2 分钟）。
6. **访问管理后台**：点开执行成功的 Action 详情，展开 `Deploy` 步骤，在日志最末尾您会看到应用的 **访问链接**。点击链接，并输入您在前面步骤中配置的 **ROOT_TOKEN** 即可登录系统。

<img src="../../images/run_cloudflare_deploy.png" width="50%" alt="触发自动部署">

### 自定义资源名称

默认情况下，部署脚本会按以下固定名称自动查找或创建资源：
- D1 数据库：`gt_ai_gateway`
- R2 对象存储桶：`gt-ai-gateway-objects`
- KV 命名空间：`gt_ai_gateway_cache`

如果需要使用自定义名称（例如避免与其他项目冲突），可以在 GitHub Secrets 中添加以下变量来覆盖：

| Secret 名称 | 说明 | 默认值 |
| :--- | :--- | :--- |
| `CLOUDFLARE_D1_NAME` | D1 数据库名称 | `gt_ai_gateway` |
| `CLOUDFLARE_R2_NAME` | R2 对象存储桶名称 | `gt-ai-gateway-objects` |
| `CLOUDFLARE_KV_NAME` | KV 命名空间名称 | `gt_ai_gateway_cache` |

添加方法与 `ROOT_TOKEN` 相同：进入 GitHub 仓库 `Settings` -> `Secrets and variables` -> `Actions`，点击 `New repository secret` 添加即可。

> ⚠️ **注意**：修改资源名称后，需要重新触发一次部署流程。如果之前已经部署过，新名称的资源需要手动创建或传入 `--auto-create-db` / `--auto-create-r2` 标志。

### 如何修改或自定义 ROOT_TOKEN？
如果您想更新自己的后台管理员密码（即 ROOT_TOKEN），可以通过以下两种方式配置：

**方式一：通过 GitHub Secrets (推荐)**
1. 进入 GitHub 仓库 `Settings` -> 左侧 `Secrets and variables` -> `Actions`。
2. 添加或更新名为 `ROOT_TOKEN` 的 Repository Secret，填入您的自定义密码。
3. 回到 `Actions` 页面，手动触发一次 `Deploy to Cloudflare` 工作流，部署完成后新密码即刻生效。

**方式二：通过 Cloudflare 控制台（不推荐）**
1. 登录 Cloudflare 面板，进入左侧菜单的 `Workers & Pages`。
2. 点击您的网关服务实例（默认名为 `gt-ai-gateway`）。
3. 点击 `Settings` (设置) 选项卡 -> 左侧选择 `Variables and Secrets`。
4. 找到 `ROOT_TOKEN` 变量，点击 `Edit` 修改为新密码，保存后 Cloudflare 会在后台自动应用生效。

> ⚠️ **注意**：通过控制台修改的方式**不推荐**，因为下次通过 GitHub Actions 部署时，脚本会用 GitHub Secrets 中的 `ROOT_TOKEN` 覆盖此值，导致您的修改丢失。请优先使用方式一。

### 后续无损更新（一键热升级）

未来当本开源项目发布了新版本时，您**只需一步操作**即可完成升级：
1. 登录您的 GitHub，进入您 Fork 的仓库。
2. 点击页面上方的 **Sync fork -> Update branch** 按钮。
3. 同步完成后，由于您仓库的代码发生了变化（`push` 到 `master`），GitHub Actions 会**自动触发**部署流程，智能保留您的 D1 数据库并热更最新代码，实现无损升级！

<img src="../../images/upgrade_code.png" width="50%" alt="一键同步更新">

---

## 对象存储配置

**关于对象存储**：
- 在 Cloudflare 环境中，使用 R2 存储可以显著提升性能，推荐开启
- 如果您的 Cloudflare 账户中没有开启 R2，系统会自动切换到使用数据库存储
- 部署完成后，可在管理后台的"设置"页面中配置对象存储方式（`auto`/`r2`/`database`）

---

## 访问系统与后续配置

部署成功后，在浏览器中打开输出的链接，输入您的 `ROOT_TOKEN` 即可登录进入管理后台。

后续的具体使用和渠道配置，请参考 [系统配置指南](../usage/ConfigurationGuide.md)。

---

> 如需手动部署或深度定制，请参考 [Cloudflare 手动部署文档](CloudflareManualDeploy.md)。
