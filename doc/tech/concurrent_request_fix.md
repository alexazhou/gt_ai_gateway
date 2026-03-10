# 并发请求跨请求 I/O 错误修复

## 问题描述

前端首页加载时，浏览器会同时发起多个 API 请求（如 `/status.json`、`/vendor/list.json`、`/model/list.json`、`/record/latest.json` 等）。在 Worker（Cloudflare Workers）模式下，这些并发请求会导致后端报错：

```
Cannot perform I/O on behalf of a different request.
I/O objects (such as streams, request/response bodies, and others) created in the context of
one request handler cannot be accessed from a different request's handler.
```

Node 模式下不一定复现，因为 Node.js 没有跨请求 I/O 隔离的限制。

## 根因分析

### Cloudflare Workers 的 I/O 隔离机制

Cloudflare Workers 配置了 `no_handle_cross_request_promise_resolution` flag（见 `wrangler.toml`），这意味着**每个请求都有独立的 I/O 上下文**。一个请求中创建的 I/O 对象（如 `env.DB` 的 D1 binding）不能在另一个请求中使用。

### knex 连接池导致跨请求 I/O

项目使用 `sutando` ORM（底层为 `knex`），通过 `knex-cloudflare-d1` driver 连接 D1 数据库。问题出在 knex 内部的连接池机制：

1. **首次请求**：`dbMiddleware` 调用 `ormService.prepareDBConnection(env.DB)`，触发 `sutando.addConnection()` 创建 knex 实例
2. **knex 创建连接池**：内部使用 `tarn.js` 连接池，调用 `Client_D1.acquireRawConnection()` 获取 D1 binding 并缓存
3. **后续并发请求**：从连接池中获取到**第一个请求创建的 D1 binding**（过期的 I/O 对象）
4. **触发错误**：使用过期的 D1 binding 执行查询 → 跨请求 I/O 错误

```
Request 1 → dbMiddleware → knex pool → acquireRawConnection() → env.DB₁ (缓存到池中)
Request 2 → dbMiddleware → knex pool → 从池中取出 env.DB₁ → ❌ 跨请求 I/O 错误
```

### 关键代码链路

```
dbMiddleware (routes.ts)
  → ormService.prepareDBConnection(c.env.DB)
    → ormService.connectCloud(db)
      → sutando.addConnection({ client: ClientD1, connection: { database: db } })
        → knex 创建 Client_D1 实例，Client_D1.d1Driver = db
        → tarn.js Pool → create → Client_D1.acquireRawConnection() → return this.d1Driver
        → Pool 缓存连接，后续请求复用 → 跨请求 I/O 错误
```

## 解决方案

在 `ormService.ts` 中通过三层 monkey-patch 绕过 knex 连接池，确保每个请求使用自己的 D1 binding：

### 1. 绕过连接池

覆盖 `Client_D1.prototype.acquireConnection`，**直接返回 `this.d1Driver`**（当前请求的 D1 binding），不再经过 tarn.js 连接池：

```typescript
ClientD1.prototype.acquireConnection = async function () {
    return this.d1Driver;
};

ClientD1.prototype.releaseConnection = async function () {
    return; // 无池可还
};
```

### 2. 确保 _query 使用当前 D1 binding

覆盖 `Client_D1.prototype._query`，忽略 `connection` 参数（可能来自过期的池），始终使用 `this.d1Driver`：

```typescript
ClientD1.prototype._query = async function (connection, obj) {
    // Date 类型写入补丁
    if (obj.bindings) {
        obj.bindings = obj.bindings.map((b) =>
            b instanceof Date ? b.toISOString() : b
        );
    }
    // 始终使用 this.d1Driver 而非 connection 参数
    return originalQuery.call(this, this.d1Driver, obj);
};
```

### 3. 每次请求更新 D1 binding

在 `connectCloud()` 的每次调用中（即每个请求），更新 `Client_D1.d1Driver` 为当前请求的 `env.DB`：

```typescript
private _updateD1Binding(db: any): void {
    const instance = (sutando as any).getInstance();
    const queryBuilder = instance.manager?.['default'];
    if (queryBuilder) {
        const knexInstance = queryBuilder.connector;
        if (knexInstance?.client) {
            knexInstance.client.d1Driver = db;
            knexInstance.client.driver = db;
        }
    }
}
```

### 4. Promise 锁防止并发初始化

首次初始化（`sutando.addConnection` + monkey-patch）使用 Promise 锁，防止并发请求重复执行初始化逻辑：

```typescript
if (!this._cloudConnected) {
    if (!this._connectPromise) {
        this._connectPromise = this._doConnectCloud(db);
    }
    await this._connectPromise;
}
```

## 涉及文件

| 文件 | 变更 |
|------|------|
| `src/service/ormService.ts` | 修复并发连接竞态条件 |
| `tests/api/concurrent/concurrent.test.ts` | 新增并发请求测试 |

## 测试验证

并发测试用例（`tests/api/concurrent/concurrent.test.ts`）覆盖三个场景：

1. **多接口并发** — 同时请求 `/status.json`、`/vendor/list.json`、`/model/list.json`、`/record/latest.json`、`/user/list.json`
2. **多轮连续并发** — 连续 3 轮，每轮 4 个并发请求
3. **同接口并发** — 同一接口 5 个并发请求

运行方式：

```bash
# Node 模式
npm test -- --run tests/api/concurrent/concurrent.test.ts

# Worker 模式
TEST_MODE=worker npx vitest --config vitest.worker.config.ts --run tests/api/concurrent/concurrent.test.ts
```
