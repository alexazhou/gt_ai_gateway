# 修订说明（v2，2026-11-24）

依据：#40 评审意见（shared/评审_请求插件规则化_2026-11-24.md）+ Operator 2026-11-24 21:10 决策。
改动范围：step1_product.md、step2_technical.md、new_api_plugin_mechanism.md §8；新增 step3_tasks.md、本文件。只改文档，未改代码，未提交。

## 一、Operator 决策落地

| 决策 | 落点 | 内容 |
|---|---|---|
| D1 tracking key 统一用后端 `claudecode_tracking_rewrite_enabled` | step2 §1、§3.3、§3.6、§6.2；step1 §2、验收 | 前端改用新 key；migrate_0035 合并旧 key：**旧 key 存在则以旧 key 值为准**写入新 key，然后删除旧 key（理由：旧 key 只由界面保存写入，代表管理员最后一次保存的意图）；`updateAll` 收到旧 key 时映射为新 key，作为过渡兼容；release note 写明「曾关闭过的部署升级后会真正关闭」 |
| D2 多规则命中按优先级、同优先级按 id 执行，全部依次执行 | step2 §1、§4.1、§8-9；step1 §1、§3 | 排序方向：`plugin.priority` 升序 → `rule.id` 升序；不去重、系统规则不做特殊处理；后一项拿到前一项应用后的结果，并给出 CCH（最后执行的生效）、粘性路由（只注入一次）、tracking（第二次无改动）三个例子 |
| D3 插件参数前端直接填 JSON，后端校验 | step2 §3.5、§3.6、§7；step1 §3、边界、验收 | 前端只用 JSON 文本框（placeholder 显示 `configExample`，仅做语法预检）；后端校验 plain object、只允许 plugin/pluginConfig 两个键、pluginConfig ≤4KB、插件 `validateConfig`（`cchValue` 必须匹配 `^[A-Za-z0-9_-]{1,32}$`，拒绝未知键）；不做字段表单 / JSON Schema |

## 二、评审 §4 必改项落地

| 评审项 | 落点 | 修订内容 |
|---|---|---|
| R2 Patch 安全 | step2 §4.2、§8-11 | 禁止根路径 `""`；先解码 JSON Pointer（`~1`/`~0`）再按首段匹配 `model`/`stream`/`stream_options`（`/modelx` 不误拦）；以插件执行项为单位在深拷贝上原子应用，有违规则整份拒绝；PROTECTED_HEADERS = `EXCLUDED_HEADERS` ∪ content-type ∪ `cf-*`/`sec-*`，抽成共享常量；`cchValue` 校验见 D3 |
| R3 去掉读路径写库 | step2 §3.3 | 删掉「首次加载时自动补齐 INSERT」；库中缺系统规则时只在内存合成虚拟规则（id=0，enabled 跟随 config），不落库；合成放在 pluginService 侧，避免出现 `ruleService → configService` 依赖 |
| R5 source 过滤与测试数据 | step2 §3.6、§6.3 | `list.json?source=user\|system`；truncate 后不重建系统规则，由内存虚拟规则兜底；`rule.test` 条数断言改为按 `source=user`；pluginService 单测重写；迁移测试覆盖 4 种场景；只用 sqlite |
| 路由注册顺序 | step2 §3.6、§8-6 | `/rule/plugins.json` 必须注册在 `/rule/:id` 之前，并加路由测试 |
| R6 时间线新旧兼容 | step2 §4.4；step1 §4 | 给出新格式（executed / warn 的 reason 枚举）；前端按是否有 `detail.executed` 区分新旧格式，历史数据不迁移 |

## 三、评审「建议改」及其他意见的处理

| 项 | 是否纳入 | 说明 |
|---|---|---|
| §2-4「立即生效」写明跨实例最长 60s | ✅ 纳入 | step1 §2、step2 §3.3 |
| §2-5「逐字节等价」改口径 | ✅ 纳入 | 改为「三个插件现有单测的输入/期望值不变」（step2 §8-2） |
| §2-6 parse 次数不作验收 | ✅ 纳入 | 改为直接调 `convertRequest(obj)`，序列化次数降低只算附带收益，删掉原验收 9 的次数断言 |
| §2-3 同步 new_api 文档 §8 | ✅ 纳入 | 对照表 5 行 + 可借鉴点第 5 条 |
| R9 RuleCache 合并重构 | ✅ 采纳「延后」 | 只新增 `pluginRules` 数组，限流/访问控制结构不动（step2 §3.4、§7） |
| 系统规则改写报错统一用 403 | ✅ 纳入 | 与共享规则只读口径一致（step2 §3.2） |
| §2-7 非 main 租户的系统规则提示文案 | ✅ 纳入 | 只改提示文案，没有新增功能（step1 §1） |
| §2-8 inspect 模式执行插件 | ✅ 纳入 | 写明与现状一致（step1 §3、step2 §4.5） |
| failover 逐次匹配写进文档 | ✅ 纳入 | 现状本来就是这样，只是写清楚（step1 §4、step2 §4.5） |
| R4 config/rule 两次写入的一致性 | ✅ 纳入 | 以 config 为准，同步失败返回 500、重试幂等；不引入事务 |
| R7 只读视图 | ✅ 纳入（轻量） | 生产环境按约定处理，单测深冻结；headers 传副本 |
| R8 默认值来源 | ✅ 纳入 | step2 §6.2 写明 migrate_0017 预置了 cch=false |
| `/rule/plugins.json` 返回参数定义 + 字段化渲染（原评审 §2-2 建议） | ❌ 未采纳 | 被 D3 取代；只返回 `configExample` 用作 placeholder，不做表单 |
| `anthropic-version` 允许插件覆盖（原稿 §5①） | ❌ 未采纳 | 原稿说"允许插件按需覆盖"，但它属于 `EXCLUDED_HEADERS`，按 R2 对齐后应受保护。目前没有插件需要改它，以后有需求再单独评审 |

## 四、需要验收人留意的取舍（均属于假设，未经 Operator 确认）

1. **D1 冲突时以旧 key 为准**：依据是旧 key 只由界面写入；新 key 只可能来自 migrate 或手工改库，目前代码里没有写入新 key 的路径。如果 Operator 希望「以新 key 为准」或者「任一为 false 即关闭」，只需改 step2 §6.2 第 2 步。
2. **`cchValue` 字符集 `^[A-Za-z0-9_-]{1,32}$`**：现有默认值 `A1234` 满足这个规则；真实 cch 值的格式没有外部规范可查，这个范围是保守取值。
3. **pluginConfig 上限 4KB**、**warn 中 error.message 截断 200 字符**：都是经验值。
