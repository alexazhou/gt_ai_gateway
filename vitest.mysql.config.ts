/**
 * T7 本地 MySQL 门专用 vitest 配置
 *
 * 与 `vitest.config.ts`（sqlite 全量门）的**差别只有两处**：
 *   1. 把 `**\/*.mysql.test.ts` 重新纳入收集；
 *   2. **只在本地门抬 `testTimeout` / `hookTimeout` 上限**（理由见下）。
 * 其余（globalSetup、串行、覆盖率地板、断言强度）全部沿用基础配置 —— 门必须跑的是**同一套用例**，
 * 只换方言；如果连用例集都不一样，「本地 MySQL 门」与「CI MySQL job」就又成了两件事。
 *
 * ⚠️ 坑 1（首跑踩到）：`mergeConfig(base, { test: { exclude: ['node_modules'] } })` **不会**「覆盖」
 * exclude —— vitest 的 mergeConfig 对数组是**合并（拼接）**，于是基础配置里的 `**\/*.mysql.test.ts`
 * 仍然生效，心跳用例根本不会被收集，而日志里「一眼看不出它没跑」（门照样红在 `usage` 上）。
 * → 所以这里不用 mergeConfig，改为「展开基础配置 + 显式替换 exclude」。
 *
 * ⚠️ 坑 2（第二次验收踩到，小马哥裁定 A）：`tests/unit/service/dbMigrationService.test.ts` 里两例
 * 各自要把 33 个迁移跑完，**本机（MySQL 在 OrbStack VM 里）全量 141 文件并发时 ~5.3s**，
 * 而 vitest 默认 `testTimeout: 5000` → 稳定/半稳定地红 1~2 例，导致「本地 28 failed ≠ CI 27 failed」，
 * 门的存在理由（本地与 CI 可对账）被破坏。CI 原生 Linux 用默认 5s 能过 → 这是**本机慢**，不是语义差异。
 *
 * 修法边界（裁定原文，不得越界）：
 * - **只改本文件（config 级）**：`testTimeout: 20000` / `hookTimeout: 30000`；
 * - **禁止**改测试文件、禁止给用例加第三个参数 `{ timeout }`、禁止 `skip`、禁止加到 60s 去掩盖别的问题；
 * - 断言、用例集、`exclude`、覆盖率地板一律不动 —— 抬的只是**上限**，不是门槛。
 * - 若抬到 20s 后 3 次全量跑仍出现抖动 → **不许继续抬**，说明不是纯超时，回来重新定因。
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
        // ⚠️ 只抬上限，不改断言/用例集（见文件头「裁定 A」）。CI 仍用基础配置的 5s。
        testTimeout: 20000,
        hookTimeout: 30000,
    },
};
