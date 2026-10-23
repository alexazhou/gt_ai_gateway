/**
 * T7 本地 MySQL 门专用 vitest 配置
 *
 * 与 `vitest.config.ts`（sqlite 全量门）的**唯一差别**：把 `**\/*.mysql.test.ts` 重新纳入收集。
 * 其余（globalSetup、串行、覆盖率地板）全部沿用基础配置 —— 门必须跑的是**同一套用例**，
 * 只换方言；如果连用例集都不一样，「本地 MySQL 门」与「CI MySQL job」就又成了两件事。
 *
 * ⚠️ 坑（首跑踩到，写在这里免得下一个人重踩）：
 * `mergeConfig(base, { test: { exclude: ['node_modules'] } })` **不会**「覆盖」exclude ——
 * vitest 的 mergeConfig 对数组是**合并（拼接）**，于是基础配置里的 `**\/*.mysql.test.ts`
 * 仍然生效，心跳用例根本不会被收集，而日志里「一眼看不出它没跑」（门照样红在 `usage` 上）。
 * → 所以这里不用 mergeConfig，改为「展开基础配置 + 显式替换 exclude」。
 *
 * 用法：`npm run test:mysql` → `scripts/run-mysql-gate.sh`（= 前置检查 + 本配置）
 */
import baseConfig from "./vitest.config";

const base: any = baseConfig;

export default {
    ...base,
    test: {
        ...base.test,
        // 显式替换（不是合并）：基础配置排除 `*.mysql.test.ts`，本门要把它放回来。
        exclude: ["node_modules"],
    },
};
