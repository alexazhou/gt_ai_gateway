# Cloudflare Workers 部署文档

本项目原生支持部署到 Cloudflare Workers，享受边缘计算带来的低延迟、高可用和零服务器维护成本。数据持久化采用 Cloudflare D1 数据库。

---

## 方案一：一键自动化部署 (推荐)

最适合没有开发环境的普通用户。通过 Cloudflare 原生的 Deploy to Cloudflare 流程，云端全自动为您完成 D1 数据库创建、表结构初始化、环境变量注入以及代码发布，**完全不需要本地环境！**

1. **点击一键部署**：
   在项目的 README 页面，点击下面这个按钮：
   [![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/alexazhou/serverless_ai_gateway/tree/feature/cloudflare-deploy-action)

2. **授权并选择资源**：
   - 网页会引导您授权 GitHub 账号，自动将代码 Fork 到您的名下。
   - 按照网页提示选择 Cloudflare 账号、Worker 名称和 D1 数据库名称。

3. **等待自动化部署**：
   - 点击部署后，系统会自动进入 Cloudflare 的原生 CI/CD 构建流程。
   - Cloudflare 会根据 `wrangler.toml` 自动创建并绑定 D1 数据库，部署命令会使用 `npm run deploy` 初始化表结构、配置 ROOT_TOKEN 并发布代码，全程约 2 分钟。

4. **获取超级管理员密码并登录**：
   - 部署完成后，点开 Cloudflare 页面的 **Deploy Log (部署日志)**，在最后的构建步骤中，您会看到自动生成的 **ROOT_TOKEN 密码** 以及应用的 **访问链接**。
   - 请妥善保存密码！打开链接，输入密码即可进入管理后台。

### 后续无损更新（热升级）

未来当本开源项目发布了新版本时，您**无需重新配置**：
1. 登录您的 GitHub，进入您 Fork 的仓库。
2. 点击页面上方的 **Sync fork -> Update branch** 按钮。
3. Cloudflare 会监听到代码变更并自动触发部署流程，智能保留您的 D1 数据库和原有数据，实现无损升级！

---

## 方案二：本地手动命令行部署 (高级开发者)

如果您希望在本地深度定制开发，可以通过命令行工具 Wrangler 手动部署。

### 1. 准备工作

1. 在本地安装 [Node.js](https://nodejs.org/) (推荐 v20 以上版本)。
2. 在项目根目录执行以下命令安装依赖：

```bash
npm install
cd frontend && npm install && cd ..
```

3. 安装并登录 Cloudflare 的命令行工具 Wrangler：

```bash
npx wrangler login
```
*这会打开浏览器并要求您授权 Wrangler 访问您的 Cloudflare 账号。*

### 2. 配置 Cloudflare D1 数据库

在项目根目录运行以下命令创建一个名为 `gt_ai_gateway` 的数据库：

```bash
npx wrangler d1 create gt_ai_gateway
```

命令执行成功后，将控制台输出的 `database_id` 填入项目根目录的 `wrangler.toml` 文件中：

```toml
[[d1_databases]]
binding = "DB"
database_name = "gt_ai_gateway"
database_id = "这里填入你刚刚生成的 database_id"
```

### 3. 初始化数据库表结构

将数据库的 Schema 和表结构应用到远程生产环境：
```bash
npx wrangler d1 migrations apply gt_ai_gateway --remote
```
*遇到提示时输入 `y` 确认执行。*

### 4. 配置 ROOT_TOKEN

在 Cloudflare Workers 中，我们通过 Secrets 来安全地存储环境变量：

```bash
npx wrangler secret put ROOT_TOKEN
```
*输入命令后，终端会提示您输入秘钥值，请设置一个强密码并牢记。*

### 5. 发布上线

```bash
npm run deploy
```

部署成功后，控制台会输出一个类似 `https://serverless-ai-gateway.your-subdomain.workers.dev` 的访问链接。

项目推荐统一使用标准部署入口。该命令会执行远程 migrations，并在缺失时自动配置 `ROOT_TOKEN`。

如果需要让部署脚本自动创建/绑定 D1 数据库，使用：

```bash
npm run deploy -- --auto-create-db
```

底层脚本仍然可以直接调用：

```bash
npm run deploy:cloudflare
```

部署脚本会优先读取当前已部署 Worker 的 `DB` D1 binding 并复用原有数据库，因此已部署实例的数据库名称不需要固定为 `gt_ai_gateway`。如果当前账号下还没有已部署的 Worker，脚本才会按 `wrangler.toml` 中的 `database_name` 查找 D1 数据库；找不到时，只有传入 `--auto-create-db` 才会自动创建，否则直接报错。

标准 `npm run deploy` 已包含 `--auto-create-root-token`。如果直接调用底层 `npm run deploy:cloudflare` 且不传该参数，请手动使用 `npx wrangler secret put ROOT_TOKEN` 配置。

---

## 访问系统与后续配置

无论您使用哪种方式部署，在浏览器中打开部署成功后输出的链接，输入您的 `ROOT_TOKEN` 即可登录进入管理后台。

后续的具体使用和渠道配置，请参考 [系统配置指南](../ConfigurationGuide.md)。
