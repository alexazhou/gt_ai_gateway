# Cloudflare Workers 手动部署文档

本文档面向需要深度定制或手动控制部署流程的高级开发者。如果只是想快速部署，请使用 [自动部署文档](CloudflareAutoDeploy.md)。

---

## 1. 准备工作

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

---

## 2. 配置 Cloudflare D1 数据库

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

> 如果需要使用自定义数据库名称，请同时修改 `database_name` 和 `wrangler.toml` 中的对应值。也可以通过环境变量 `CLOUDFLARE_D1_NAME` 在自动部署时覆盖。

---

## 3. 配置 Cloudflare R2 对象存储桶 (推荐)

**关于对象存储**：
- 在 Cloudflare 环境中，使用 R2 存储可以显著提升性能，推荐开启
- 如果您的 Cloudflare 账户中没有开启 R2，系统会自动切换到使用数据库存储
- 部署完成后，可在管理后台的"设置"页面中配置对象存储方式（`auto`/`r2`/`database`）

`wrangler.toml` 默认已声明如下绑定：

```toml
[[r2_buckets]]
binding = "OBJECT_BUCKET"
bucket_name = "gt-ai-gateway-objects"
```

创建对应的 R2 桶（名称需与 `bucket_name` 一致）：

```bash
npx wrangler r2 bucket create gt-ai-gateway-objects
```

> 若想改用已有的 R2 桶，把 `bucket_name` 改成你的桶名即可，无需重新创建。也可以通过环境变量 `CLOUDFLARE_R2_NAME` 在自动部署时覆盖。

---

## 4. 配置 Cloudflare KV 命名空间 (可选)

如果需要使用 KV 缓存，在 `wrangler.toml` 中取消注释并配置：

```toml
[[kv_namespaces]]
binding = "CACHE"
id = "你的 KV 命名空间 ID"
```

创建 KV 命名空间：

```bash
npx wrangler kv namespace create CACHE
```

然后将输出的 `id` 填入 `wrangler.toml`。也可以通过环境变量 `CLOUDFLARE_KV_NAME` 在自动部署时覆盖。

---

## 5. 初始化数据库表结构

将数据库的 Schema 和表结构应用到远程生产环境：
```bash
npm run db:migrate:worker-cloud
```
该命令会通过 `wrangler.toml` 中的 `DB` binding 连接远程 D1，并执行项目内置的 `resource/migrate` 迁移脚本。

---

## 6. 配置 ROOT_TOKEN

在 Cloudflare Workers 中，我们通过 Secrets 来安全地存储环境变量：

```bash
npx wrangler secret put ROOT_TOKEN
```
*输入命令后，终端会提示您输入秘钥值，请设置一个强密码并牢记。*

---

## 7. 发布上线

```bash
npm run deploy
```

部署成功后，控制台会输出一个类似 `https://serverless-ai-gateway.your-subdomain.workers.dev` 的访问链接。

也可以通过底层脚本直接调用：

```bash
npm run deploy:cloudflare
```

> 底层脚本默认不包含自动创建资源的逻辑，需要手动创建 D1 数据库、R2 桶等。如果希望自动创建，请使用 `npm run deploy` 并传入相应标志。

---

## 访问系统与后续配置

部署成功后，在浏览器中打开输出的链接，输入您的 `ROOT_TOKEN` 即可登录进入管理后台。

后续的具体使用和渠道配置，请参考 [系统配置指南](../usage/ConfigurationGuide.md)。
