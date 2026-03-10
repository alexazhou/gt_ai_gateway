# v2.x - 监控分析技术实现方案（v2.0 + v2.1）

## 一、技术栈确认

### 1.1 核心技术（延续 v1.x）
| 技术 | 版本 | 用途 |
|------|------|------|
| Vue | 3.4+ | 前端框架 |
| TypeScript | 5.0+ | 类型系统 |
| Vite | 5.0+ | 构建工具 |
| Ant Design Vue | 4.x | UI 组件库 |
| Vue Router | 4.x | 路由管理 |
| Pinia | 2.x | 状态管理 |
| Axios | 1.x | HTTP 请求 |

### 1.2 新增辅助库
| 库 | 用途 |
|------|------|
| @antv/g2plot | 图表可视化（仪表盘统计） |
| vue-json-viewer / vue3-json-viewer | JSON 语法高亮展示 |
| @microsoft/fetch-event-source | SSE 流式响应处理 |

---

## 二、项目结构（v2.x 新增）

```
frontend/
├── src/
│   ├── api/               # API 请求模块（新增）
│   │   ├── record.ts      # 请求记录相关 API
│   │   ├── stats.ts       # 统计数据相关 API
│   │   └── gateway.ts     # 网关 AI 调用 API
│   ├── components/        # 公共组件（新增）
│   │   └── common/
│   │       ├── JsonViewer.vue      # JSON 数据展示组件
│   │       ├── StreamOutput.vue    # 流式响应展示组件
│   │       └── StatisticCard.vue   # 统计卡片组件
│   ├── composables/       # 组合式函数（新增）
│   │   ├── useAutoRefresh.ts       # 自动刷新逻辑
│   │   └── useStreamResponse.ts    # 流式响应处理
│   ├── types/             # 类型定义（新增）
│   │   ├── record.ts      # 请求记录类型
│   │   ├── stats.ts       # 统计数据类型
│   │   └── gateway.ts     # API 测试类型
│   ├── utils/             # 工具函数（新增）
│   │   ├── format.ts      # 数据格式化（新增 JSON 格式化）
│   │   └── sse.ts         # SSE 处理工具
│   └── views/             # 页面视图（新增）
│       ├── Record/        # 请求记录模块
│       │   ├── Index.vue
│       │   ├── List.vue
│       │   └── Detail.vue
│       └── ApiTest/       # API 测试工具
│           └── Index.vue
```

---

## 三、类型定义

### 3.1 请求记录类型（src/types/record.ts）

| 类型/接口 | 用途 | 关键字段 |
|-----------|------|----------|
| `RequestStatus` | 请求状态枚举 | 'success' \| 'failed' |
| `Record` | 请求记录实体 | user_id, vendor_id, model_id, status, request_data, response_data |
| `RecordRequestData` | 请求数据结构 | model, messages, temperature, max_tokens, stream |
| `RecordResponseData` | 响应数据结构 | choices, usage, error |
| `RecordQuery` | 记录查询条件 | status?, user_name?, model_name?, start_time?, end_time? + 分页 |
| `RecordListResponse` | 列表响应 | list, total |

### 3.2 统计数据类型（src/types/stats.ts）

| 类型/接口 | 用途 | 关键字段 |
|-----------|------|----------|
| `DashboardStats` | 仪表盘统计数据 | total_requests, success_rate, active_users, active_models, today_requests |
| `RecentRecord` | 最近记录摘要 | id, user_name, model_name, status, created_at |
| `TimeRangeStats` | 时间段统计 | date, count, success_count, failed_count |

### 3.3 API 测试类型（src/types/gateway.ts）

| 类型/接口 | 用途 | 关键字段 |
|-----------|------|----------|
| `ApiFormat` | API 格式枚举 | 'openai' \| 'anthropic' |
| `TestMessage` | 测试消息 | role, content |
| `ApiTestRequest` | 测试请求 | format, model, messages, temperature?, max_tokens?, stream? |
| `ApiTestHistory` | 测试历史 | id, timestamp, request, response, status |
| `StreamChunk` | 流式响应块 | choices[].delta.content |

---

## 四、API 模块接口

### 4.1 请求记录 API 模块（src/api/record.ts）

| 函数名 | 请求方法 | 接口路径 | 参数 | 返回值 |
|--------|----------|----------|------|--------|
| `listRecords` | GET | /record/list.json | query?: RecordQuery | RecordListResponse |
| `latestRecords` | GET | /record/latest.json | limit?: number | Record[] |
| `getRecord` | GET | /record/{id} | id: number | Record |
| `deleteRecord` | DELETE | /record/{id} | id: number | void |

### 4.2 统计数据 API 模块（src/api/stats.ts）

| 函数名 | 请求方法 | 接口路径 | 参数 | 返回值 |
|--------|----------|----------|------|--------|
| `getDashboardStats` | GET | /stats/dashboard.json | - | DashboardStats |
| `getRecentRecords` | GET | /stats/recent.json | limit?: number | RecentRecord[] |

### 4.3 网关 AI API 模块（src/api/gateway.ts）

| 函数名 | 说明 | 参数 | 返回值 |
|--------|------|------|--------|
| `chatCompletions` | 流式或非流式 AI 调用 | data: ApiTestRequest, onMessage?, onComplete?, onError? | Promise<void> |

---

## 五、状态管理（Pinia）

### 5.1 记录状态（src/stores/record.ts）

**Store 名称**: `record`

**State**:
| 字段名 | 类型 | 说明 |
|--------|------|------|
| `records` | Ref<Record[]> | 记录列表 |
| `total` | Ref<number> | 总条数 |
| `loading` | Ref<boolean> | 加载状态 |
| `autoRefresh` | Ref<boolean> | 自动刷新状态 |

**Actions**:
| 方法名 | 参数 | 返回值 | 说明 |
|--------|------|--------|------|
| `fetchRecords` | query?: any | Promise<void> | 获取记录列表 |
| `fetchLatest` | limit?: number | Promise<void> | 获取最新记录 |
| `startAutoRefresh` | interval?: number, callback? | void | 开启自动刷新 |
| `stopAutoRefresh` | - | void | 停止自动刷新 |

### 5.2 统计状态（src/stores/stats.ts）

**Store 名称**: `stats`

**State**:
| 字段名 | 类型 | 说明 |
|--------|------|------|
| `stats` | Ref<DashboardStats \| null> | 统计数据 |
| `recentRecords` | Ref<RecentRecord[]> | 最近记录 |
| `loading` | Ref<boolean> | 加载状态 |
| `lastUpdated` | Ref<Date \| null> | 最后更新时间 |

**Getters**:
| 名称 | 返回类型 | 说明 |
|------|----------|------|
| `isStatsValid` | Computed<boolean> | 数据是否在有效期内（60秒） |

**Actions**:
| 方法名 | 参数 | 返回值 | 说明 |
|--------|------|--------|------|
| `fetchStats` | force?: boolean | Promise<void> | 获取仪表盘统计 |
| `fetchRecent` | limit?: number | Promise<void> | 获取最近记录 |
| `refreshAll` | - | Promise<void> | 刷新所有数据 |

### 5.3 API 测试状态（src/stores/apiTest.ts）

**Store 名称**: `apiTest`

**State**:
| 字段名 | 类型 | 说明 |
|--------|------|------|
| `loading` | Ref<boolean> | 请求加载状态 |
| `responseText` | Ref<string> | 响应文本 |
| `history` | Ref<ApiTestHistory[]> | 测试历史记录 |

**Actions**:
| 方法名 | 参数 | 返回值 | 说明 |
|--------|------|--------|------|
| `sendRequest` | request: ApiTestRequest, onChunk? | Promise<void> | 发送测试请求 |
| `clearHistory` | - | void | 清空历史记录 |
| `removeHistoryItem` | id: string | void | 删除单条历史 |
| `loadHistoryItem` | item: ApiTestHistory | ApiTestRequest | 加载历史配置 |

---

## 六、路由配置（新增）

### 6.1 新增路由表

| 路径 | 名称 | 组件 | 元信息 |
|------|------|------|--------|
| /record | Record | Record/Index.vue | title: '请求记录' |
| /record | RecordList | Record/List.vue | - |
| /record/:id | RecordDetail | Record/Detail.vue | - |
| /api-test | ApiTest | ApiTest/Index.vue | title: 'API 测试' |

---

## 七、公共组件接口

### 7.1 JSON 查看器组件（src/components/common/JsonViewer.vue）

**Props**:
| 属性名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `data` | any | 是 | 要展示的 JSON 数据 |

**功能**:
- 格式化展示 JSON 数据
- 支持复制 JSON 到剪贴板
- 支持展开/收起

### 7.2 流式输出组件（src/components/common/StreamOutput.vue）

**Props**:
| 属性名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| `content` | string | 是 | 响应内容 |
| `loading` | boolean | 是 | 是否加载中 |

**Events**:
| 事件名 | 说明 |
|--------|------|
| `stop` | 用户点击停止按钮 |
| `clear` | 用户点击清除按钮 |

**功能**:
- 展示流式响应内容
- 显示状态指示（等待中/生成中/已完成）
- 打字机动画效果

### 7.3 统计卡片组件（src/components/common/StatisticCard.vue）

**Props**:
| 属性名 | 类型 | 必填 | 默认值 | 说明 |
|--------|------|------|--------|------|
| `title` | string | 是 | - | 卡片标题 |
| `value` | number | 是 | - | 统计数值 |
| `precision` | number | 否 | - | 小数精度 |
| `suffix` | string | 否 | - | 单位后缀 |
| `icon` | Component | 否 | - | 前缀图标 |
| `description` | string | 否 | - | 描述文本 |
| `loading` | boolean | 否 | false | 加载状态 |
| `color` | string | 否 | '#1890ff' | 数值颜色 |

---

## 八、组合式函数接口

### 8.1 自动刷新组合式函数（src/composables/useAutoRefresh.ts）

**参数**:
| 参数名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `callback` | () => void \| Promise<void> | - | 刷新回调函数 |
| `defaultInterval` | number | 30000 | 默认刷新间隔（毫秒） |

**返回值**:
| 属性/方法 | 类型 | 说明 |
|-----------|------|------|
| `isRunning` | Ref<boolean> | 是否运行中 |
| `interval` | Ref<number> | 当前刷新间隔 |
| `start` | () => void | 开始自动刷新 |
| `stop` | () => void | 停止自动刷新 |
| `restart` | () => void | 重新开始 |
| `setIntervalValue` | (value: number) => void | 设置刷新间隔 |

### 8.2 流式响应组合式函数（src/composables/useStreamResponse.ts）

**返回值**:
| 属性/方法 | 类型 | 说明 |
|-----------|------|------|
| `content` | Ref<string> | 响应内容 |
| `loading` | Ref<boolean> | 加载状态 |
| `error` | Ref<string \| null> | 错误信息 |
| `send` | (request, options?) => Promise<void> | 发送请求 |
| `clear` | () => void | 清除内容 |

---

## 九、环境变量配置

### 9.1 新增环境变量

| 变量名 | 用途 | 示例值 |
|--------|------|--------|
| `VITE_AUTO_REFRESH_INTERVAL` | 自动刷新间隔（毫秒） | 30000 |
| `VITE_MAX_HISTORY_COUNT` | 最大历史记录数 | 50 |

---

## 十、依赖安装

### 10.1 v2.x 新增依赖

```bash
# 图表库（仪表盘用）
npm install @antv/g2plot

# JSON 查看器
npm install vue3-json-viewer

# SSE 流式响应
npm install @microsoft/fetch-event-source
```

---

*文档版本：v1.0*
*创建日期：2026-03-08*
