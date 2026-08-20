# 源码方式启动部署文档

如果您是开发者希望参与贡献，或者希望在个人电脑、私有服务器上以最原生 Node.js 方式运行系统，可以参考本文档。

---

## 1. 环境准备

在开始之前，请确保您的系统中已安装以下软件：

1. [Node.js](https://nodejs.org/) (推荐 v20 或以上版本)
2. [Git](https://git-scm.com/) (用于拉取代码)

---

## 2. 拉取代码与安装依赖

1. 克隆项目到本地：
```bash
git clone https://github.com/alexazhou/gt_ai_gateway.git
cd gt_ai_gateway
```

2. 安装后端与前端依赖：
```bash
npm install
cd frontend && npm install && cd ..
```

---

## 3. 环境变量配置

在项目根目录下复制环境变量模板，并创建真实的 `.dev.vars` 文件：

```bash
cp .dev.vars.template .dev.vars
```

打开 `.dev.vars` 文件，根据您的需要进行修改。主要的必填配置是管理员密钥：
```env
# 超级管理员的登录密码，建议修改为您的专属密码
ROOT_TOKEN=your-secret-root-token

# 服务运行端口，默认 8720
PORT=8720

# SQLite 数据库的存放路径（默认为根目录的 local.db）
DB_PATH=local.db
```

---

## 4. 运行模式

源码运行分为**开发模式 (Dev)**和**生产模式 (Prod)**。

### 开发模式 (Dev)

开发模式下支持代码热重载，非常适合二次开发和调试。此时我们需要开启两个终端分别运行后端和前端：

**终端 1：启动后端**
```bash
# 这会在本地启动后端 API 和 SQLite 数据库，监听 8720 端口
npm run backend:dev:local
```

**终端 2：启动前端**
```bash
# 这会启动前端 Vite 开发服务器，监听 8721 端口
npm run frontend:dev
```

在浏览器中访问 `http://localhost:8721` 即可打开带热更新的系统后台。

---

### 生产环境模式 (Prod)

如果您在服务器上使用源码启动，通常希望以生产模式运行（前后端同域、性能更好）。

**1. 编译前端静态资源**
```bash
# 将前端代码编译并打包至后端的静态资源托管目录下
npm run frontend:build
```

**2. 启动服务端**
```bash
# 启动 Node.js 原生后端服务，并同时接管前端静态资源的路由
npm run backend:start:node
```

在浏览器中访问 `http://localhost:8720` 即可打开系统管理后台。

为了保证服务在后台常驻运行且在崩溃后自动重启，推荐配合 [PM2](https://pm2.keymetrics.io/) 来管理生产模式进程：
```bash
# 全局安装 pm2
npm install pm2 -g

# 使用 pm2 启动并命名服务为 gt_ai_gateway
pm2 start script/run-node.ts --interpreter ./node_modules/.bin/tsx --name gt_ai_gateway

# 查看服务状态与日志
pm2 status
pm2 logs gt_ai_gateway
```

---

## 5. 后续操作

服务启动完毕后，输入您在 `.env` 中配置的 `ROOT_TOKEN` 即可登录进入管理后台。

后续的具体使用和渠道配置，请参考 [系统配置指南](../ConfigurationGuide.md)。
