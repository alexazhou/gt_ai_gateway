# v2.x - 开发任务清单（v2.0 + v2.1）

## 任务概览

| 版本 | 模块 | 预计工时 |
|------|------|----------|
| v2.0 | 请求记录模块 | 2-3 天 |
| v2.1 | 仪表盘增强 + API 测试 | 2-3 天 |

---

## v2.0 - 请求记录模块

### 第一阶段：基础类型与 API（0.5 天）

| 序号 | 任务 | 文件路径 | 状态 |
|------|------|----------|------|
| 1 | 创建请求记录类型定义 | `src/types/record.ts` | ⬜ |
| 2 | 创建统计数据类型定义 | `src/types/stats.ts` | ⬜ |
| 3 | 创建记录 API 模块 | `src/api/record.ts` | ⬜ |
| 4 | 创建统计 API 模块 | `src/api/stats.ts` | ⬜ |

### 第二阶段：状态管理（0.5 天）

| 序号 | 任务 | 文件路径 | 状态 |
|------|------|----------|------|
| 5 | 创建记录状态管理 | `src/stores/record.ts` | ⬜ |
| 6 | 创建统计状态管理 | `src/stores/stats.ts` | ⬜ |
| 7 | 创建自动刷新组合式函数 | `src/composables/useAutoRefresh.ts` | ⬜ |

### 第三阶段：公共组件（0.5 天）

| 序号 | 任务 | 文件路径 | 状态 |
|------|------|----------|------|
| 8 | 创建 JSON 查看器组件 | `src/components/common/JsonViewer.vue` | ⬜ |
| 9 | 创建统计卡片组件 | `src/components/common/StatisticCard.vue` | ⬜ |

### 第四阶段：页面开发（1-1.5 天）

| 序号 | 任务 | 文件路径 | 状态 |
|------|------|----------|------|
| 10 | 创建记录列表页面 | `src/views/Record/List.vue` | ⬜ |
| 11 | 创建记录详情页面 | `src/views/Record/Detail.vue` | ⬜ |
| 12 | 创建记录模块入口 | `src/views/Record/Index.vue` | ⬜ |
| 13 | 添加记录模块路由 | `src/router/index.ts` | ⬜ |
| 14 | 更新侧边栏菜单 | `src/components/layout/AppSidebar.vue` | ⬜ |

---

## v2.1 - 仪表盘增强与 API 测试

### 第一阶段：网关 API 模块（0.5 天）

| 序号 | 任务 | 文件路径 | 状态 |
|------|------|----------|------|
| 15 | 创建网关 API 类型定义 | `src/types/gateway.ts` | ⬜ |
| 16 | 创建网关 API 模块 | `src/api/gateway.ts` | ⬜ |
| 17 | 安装 SSE 依赖 | `package.json` | ⬜ |
| 18 | 创建流式响应组合式函数 | `src/composables/useStreamResponse.ts` | ⬜ |

### 第二阶段：API 测试状态与组件（0.5 天）

| 序号 | 任务 | 文件路径 | 状态 |
|------|------|----------|------|
| 19 | 创建 API 测试状态管理 | `src/stores/apiTest.ts` | ⬜ |
| 20 | 创建流式输出组件 | `src/components/common/StreamOutput.vue` | ⬜ |

### 第三阶段：API 测试页面（0.5-1 天）

| 序号 | 任务 | 文件路径 | 状态 |
|------|------|----------|------|
| 21 | 创建 API 测试页面 | `src/views/ApiTest/Index.vue` | ⬜ |
| 22 | 添加 API 测试路由 | `src/router/index.ts` | ⬜ |
| 23 | 更新侧边栏菜单 | `src/components/layout/AppSidebar.vue` | ⬜ |

### 第四阶段：仪表盘增强（0.5 天）

| 序号 | 任务 | 文件路径 | 状态 |
|------|------|----------|------|
| 24 | 安装图表库 | `package.json` | ⬜ |
| 25 | 增强仪表盘统计展示 | `src/views/Dashboard.vue` | ⬜ |
| 26 | 添加图表组件（可选） | `src/components/charts/` | ⬜ |
| 27 | 实现自动刷新控制 | `src/views/Dashboard.vue` | ⬜ |

---

## 依赖安装清单

### v2.0 依赖

```bash
# 图表库（仪表盘用）
npm install @antv/g2plot

# JSON 查看器
npm install vue3-json-viewer
```

### v2.1 依赖

```bash
# SSE 流式响应
npm install @microsoft/fetch-event-source
```

---

## API 接口确认

### 记录相关接口

| 接口 | 方法 | 路径 | 说明 |
|------|------|------|------|
| 获取记录列表 | GET | `/record/list.json` | 支持分页、筛选 |
| 获取最新记录 | GET | `/record/latest.json` | 用于仪表盘展示 |
| 获取记录详情 | GET | `/record/:id` | 查看单条记录详情 |

### 统计相关接口

| 接口 | 方法 | 路径 | 说明 |
|------|------|------|------|
| 仪表盘统计 | GET | `/stats/dashboard.json` | 今日请求数、成功率等 |
| 最近记录 | GET | `/stats/recent.json` | 最近 N 条记录摘要 |

### AI 调用接口

| 接口 | 方法 | 路径 | 说明 |
|------|------|------|------|
| Chat Completions | POST | `/v1/chat/completions` | OpenAI 格式，支持 SSE |
| Anthropic Messages | POST | `/v1/messages` | Anthropic 格式 |

---

## 页面路由规划

| 路径 | 名称 | 组件 | 说明 |
|------|------|------|------|
| `/record` | Record | Record/Index.vue | 记录模块入口 |
| `/record` | RecordList | Record/List.vue | 记录列表 |
| `/record/:id` | RecordDetail | Record/Detail.vue | 记录详情 |
| `/api-test` | ApiTest | ApiTest/Index.vue | API 测试工具 |

---

## 验收标准

### v2.0 验收标准

- [ ] 请求记录列表正常展示，支持分页
- [ ] 支持按状态、时间范围、用户名、模型名筛选
- [ ] 记录详情页展示请求数据和响应数据
- [ ] JSON 数据展示正确，支持复制
- [ ] 自动刷新功能正常工作

### v2.1 验收标准

- [ ] 仪表盘展示今日请求数、成功率等统计数据
- [ ] 统计数据自动刷新（30秒间隔）
- [ ] API 测试工具可选择模型、发送请求
- [ ] 支持流式响应展示
- [ ] 测试历史记录保存和加载正常

---

## 风险与注意事项

1. **后端接口可能未完全实现**：需要与后端确认接口返回格式
2. **SSE 跨域问题**：本地开发时可能需要配置代理
3. **大数据量 JSON 渲染性能**：记录详情页 JSON 过大时考虑虚拟滚动
4. **流式响应中断处理**：用户主动停止时需要正确关闭连接

---

*文档版本：v1.0*
*创建日期：2026-03-08*
