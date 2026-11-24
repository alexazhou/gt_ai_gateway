# 请求插件规则化 - 实施任务拆分（step3）

日期：2026-11-24　依据：[step2_technical.md](./step2_technical.md) 修订 v2
单位：人日（单人估算，含自测；不含联调等待）。所有自动化测试只用本地 sqlite。

## 依赖关系

```
T1 插件框架 ──┬─→ T2 内置插件迁移 ──┐
              │                      ├─→ T5 sender 管线 ──┐
T3 规则模型/迁移/接口 ─┬─→ T4 设置联动 ┘                   ├─→ T7 集成测试与回归
                      └─→ T6 前端 ─────────────────────────┘
```
T1 与 T3 可并行；T6 在 T3 接口（`source` 字段、`/rule/plugins.json`、`source` 过滤）定稿后即可开工。

## 任务清单

| # | 任务 | 范围（对应 step2 章节） | 交付标准 | 估时 | 依赖 |
|---|---|---|---|---|---|
| T1 | 插件框架 | `src/plugin/types.ts`、`pluginRegistry`（注册校验/list）、JSON Patch 引擎（add/replace/remove、JSON Pointer 解码、禁根路径、按首段保护、深拷贝原子应用）、headerPatch（PROTECTED_HEADERS 与 `EXCLUDED_HEADERS` 抽共享常量）（§2、§4.2） | 单测覆盖：三种 op 正常/路径不存在/数组越界；根路径、`/model`、`/model/x`、`~1` 绕过、`/modelx` 放行；保护头含 `cf-*`/`sec-*`；一条违规则整份不生效 | 1.5 | — |
| T2 | 内置插件迁移 | 三个插件改为 hook + patch；`cchRewriter.validateConfig`（`^[A-Za-z0-9_-]{1,32}$`、拒绝未知键）；无参插件要求 `{}`；`configExample`（§6.1、§3.5） | 原有三套插件单测的输入/期望值全部保留并通过（行为等价基准）；单测中 body 深冻结；新增 `cchValue` 校验用例 | 1 | T1 |
| T3 | 规则模型、迁移与接口 | `RuleType.PLUGIN`、`RuleSource`、`SgRule` 字段；migrate_0035（sqlite+mysql：加列/索引、tracking 旧 key 合并并删除、三条系统规则）；`validateRule` 的 PLUGIN 分支与 pluginConfig 校验；系统规则只读（403）、忽略 `source`/`biz_id`；`upsertSystemRuleByBizId`；`RuleCache.pluginRules` + `getMatchedPluginRules`（不动限流结构）；`/rule/plugins.json`（注册在 `/rule/:id` 之前）；`list.json?source=`（§3、§6.2） | 迁移四种场景测试通过（全新库 / 旧库无 tracking key / 旧 key=false / 新旧 key 冲突以旧为准）；系统规则改/删 403；plugins.json 路由测试；source 过滤测试；限流/访问控制现有测试零回归 | 2 | — |
| T4 | 设置联动 | `configService.setValue` 联动 `syncSystemPluginRuleByConfig`；`updateAll` 旧 tracking key 映射为新 key + warn；同步失败返回 500、重试幂等；缺失系统规则的内存虚拟规则（在 pluginService 侧合成，不写库）（§3.3） | `PUT /config.json` 切换三开关后系统规则 `enabled` 变化且即时生效；旧 key 提交被映射；truncate 后插件行为跟随 config 且 rule 表无写入；无循环依赖 | 0.5 | T3 |
| T5 | sender 管线改造 | 一次 parse；`applyBeforeConversion` / `applyAfterConversion`；`converter.convertRequest(obj)` + 抽出错误包装；`stream_options`/认证头/Content-Type 后置；新 activity 格式与 warn 格式；failover 逐次匹配（§4、§5） | 同协议只调 before、跨协议各一次；`stream_options` 仍正确注入；未修改不写 activity；handler 抛异常请求照常发出；现有 sender/转换相关测试零回归 | 1 | T1、T2、T3 |
| T6 | 前端 | 规则页「用户 / 系统」两区（带 `source` 查询）；plugin 类型表单（插件下拉 + JSON 文本框 + 语法预检，业务错误展示后端 message）；系统规则只读 + 主/非主租户提示文案；`types/rule.ts`；`ActivityTimeline` 新旧格式兼容；AdvancedSettings / `types/config.ts` 改用 `claudecode_tracking_rewrite_enabled`（§3.6、§4.4） | 前端构建通过；手工走查：新建/编辑/启停/删除 plugin 用户规则、非法 JSON 提示、系统规则不可操作、tracking 开关关闭后真实生效、新旧时间线记录均可显示 | 1.5 | T3（接口） |
| T7 | 集成测试与回归 | API 级：CCH 系统规则 + 用户规则叠加（上游收到用户值）、多规则 ruleId 升序、scope 三维度、跨协议两阶段、failover 二次匹配、补丁安全、pluginService 测试重写；`rule.test.ts` 条数断言改为 `source=user`；全量 node 测试回归（§8） | §8 验收 1～14 均有对应用例或走查记录；全量本地 sqlite 测试通过；mysql.sql 人工语法核对记录 | 1.5 | T2、T4、T5、T6 |

**合计：约 9 人日**（T1 1.5 + T2 1 + T3 2 + T4 0.5 + T5 1 + T6 1.5 + T7 1.5）。两人并行（后端 T1→T2→T5、T3→T4；前端/测试 T6→T7）时日历周期约 5 个工作日。

与 #40 评审估算（8～9 人日）相比取上限：T3 新增 tracking 旧 key 合并迁移与 `source` 过滤（+0.5）；去掉字段化表单、RuleCache 不重构各省一点，与新增项基本抵消。

## 发布注意事项（写入 release note）

- 「屏蔽 Claude Code 跟踪」开关修复：曾在界面关闭过的部署，升级后该改写**真正关闭**。
- 规则管理新增「系统规则」区，三条系统规则只能在「高级设置 → 请求处理」中启停。
- 规则接口：系统规则改/删返回 403；`list.json` 新增 `source` 参数（不传行为不变）。
- `updateAll` 的旧 tracking key 映射为过渡兼容，计划下一个大版本移除。

## 风险与回滚

- 迁移不可逆部分：删除旧 tracking key 行（其值已合并到新 key，信息不丢失）。回滚到旧版本时，旧前端仍会读写旧 key，此时 tracking 开关在界面上显示为默认的"开启"——属于回到旧版已知 bug 的状态，不会引入新的问题。
- 新增列都有默认值，旧版本代码忽略这些列即可，向后兼容。
