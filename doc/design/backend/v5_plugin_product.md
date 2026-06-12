# v5.0 请求改写插件系统产品文档

## 概述

请求改写插件系统允许在请求被转发到上游模型之前，对请求体进行动态修改。每个插件包含独立的改写逻辑，接收完整的请求体作为输入，输出一个 patch 合并回请求体。多个插件按顺序依次执行，每个插件可以单独启用或禁用。

---

## 核心概念

### 插件（Plugin）

一个插件代表一条独立的改写规则，包含具体的改写逻辑。

| 属性 | 说明 |
|------|------|
| 名称 | 描述性名称，便于识别用途 |
| 逻辑 | 插件的改写逻辑（脚本/规则），决定如何修改请求体 |
| 是否启用 | 可随时开关，不影响其他插件 |
| 执行顺序 | 决定多个插件的执行先后顺序 |

### 执行模型

```
原始请求体
    │
    ▼
[插件 1]  输入: 当前请求体 → 输出: patch₁ → merge → 中间请求体₁
    │
    ▼
[插件 2]  输入: 中间请求体₁ → 输出: patch₂ → merge → 中间请求体₂
    │
    ▼
   ...
    │
    ▼
最终请求体（发往上游）
```

每个插件接收**当前最新**的请求体，输出一个 Patch 对象。Patch 采用 JSON Merge Patch（RFC 7396）语义：
- 有值的字段：覆盖原字段
- `null` 值的字段：删除原字段
- 未出现的字段：保留不变

### 插件作用范围

插件绑定在**模型**上，每个模型可以配置自己的插件列表。

---

## 插件逻辑

插件的改写逻辑以 JavaScript 脚本的形式定义。脚本接收 `body`（当前请求体对象），返回一个 patch 对象。

**脚本签名**
```javascript
function modify(body) {
    // body: 当前完整的请求体对象（已解析的 JSON）
    // 返回值: patch 对象，将被 merge 到请求体
    return { /* patch */ };
}
```

**示例：强制限制输出长度**
```javascript
function modify(body) {
    return { max_tokens: 4096 };
}
```

**示例：前置系统提示**
```javascript
function modify(body) {
    const prefix = "请始终用中文回复。\n\n";
    return {
        system: prefix + (body.system || "")
    };
}
```

**示例：删除不兼容字段**
```javascript
function modify(body) {
    return { user: null, stream: null };
}
```

**示例：根据条件改写**
```javascript
function modify(body) {
    if (body.max_tokens > 8192) {
        return { max_tokens: 8192 };
    }
    return {};
}
```

---

## 数据模型

### `plugin` 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键 |
| model_id | INTEGER | 关联的模型 ID |
| name | VARCHAR | 插件名称 |
| script | TEXT | 改写逻辑脚本（JavaScript） |
| enabled | BOOLEAN | 是否启用，默认 true |
| order | INTEGER | 执行顺序，数字越小越先执行 |
| created_at | DATETIME | 创建时间 |
| updated_at | DATETIME | 更新时间 |

---

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/plugin/list.json?model_id=:id` | 获取某模型的插件列表 |
| POST | `/plugin/create.json` | 创建插件 |
| PUT | `/plugin/update.json` | 更新插件 |
| POST | `/plugin/toggle.json` | 启用/禁用插件 |
| DELETE | `/plugin/delete.json` | 删除插件 |

### 创建插件请求体

```json
{
  "model_id": 1,
  "name": "限制输出长度",
  "script": "function modify(body) { return { max_tokens: 4096 }; }",
  "order": 10
}
```

### 插件列表响应

```json
[
  {
    "id": 1,
    "model_id": 1,
    "name": "限制输出长度",
    "script": "function modify(body) { return { max_tokens: 4096 }; }",
    "enabled": true,
    "order": 10
  },
  {
    "id": 2,
    "model_id": 1,
    "name": "前置系统提示",
    "script": "function modify(body) { return { system: '请始终用中文回复。\\n\\n' + (body.system || '') }; }",
    "enabled": false,
    "order": 20
  }
]
```

---

## 执行流程

1. 请求进入网关，根据模型 ID 加载该模型的**已启用插件列表**，按 `order` 升序排列
2. 按顺序逐个执行插件脚本：
   - 将当前请求体传入脚本的 `modify` 函数
   - 将返回的 patch 以 JSON Merge Patch 方式合并到请求体
3. 最终请求体发往上游

如果某个插件脚本执行出错，记录日志，**跳过该插件**，继续执行后续插件，不中断请求。

---

## 前端管理界面

在模型详情页增加「请求插件」标签页：

- 插件列表，展示名称、启用状态、执行顺序
- 支持拖拽调整顺序
- 每行有开关可直接切换启用状态
- 新增/编辑插件弹窗：填写名称 + 代码编辑器写脚本
- 删除插件（需确认）

---

## 设计约束

- 插件只能修改**请求体**，不能修改响应
- 脚本在沙箱中运行，不能访问网络、文件系统或全局状态
- 脚本执行有超时限制（建议 100ms），超时视为执行失败
- 脚本返回值必须是对象，否则视为执行失败（返回 `{}`）
