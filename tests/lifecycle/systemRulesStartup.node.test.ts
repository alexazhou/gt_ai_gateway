import { spawnSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import configService from "../../src/service/configService";
import { SYSTEM_PLUGIN_RULES } from "../../src/plugin/systemRules";

/**
 * **起步接线判据**（#382 验收打回点 1）：`ormService.init()` 必须生成系统规则。
 *
 * 背景：`ensureSystemRules()` 在 node / MySQL 形态下只挂在 `ormService.init()` 里，而现有用例
 * 全都经 `dbHelper.truncate()` → `POST /test/ensure-system-rules` 显式调 ensure，等于把这条接线
 * 遮住了。验收实测：把 init 里那行 ensure 删掉，node 全量 168 文件 1860 例**全绿**——
 * 「删掉一行代码、全新安装没有系统规则（四个插件整体不执行）」这种事故没有任何判据会红。
 *
 * 做法：起一个子进程（`tests/helpers/ormInitProbe.ts`）在**全新的空 sqlite 库**上跑
 * `ormService.init()`，父进程直接读库文件断言四条系统规则已生成。
 * 本用例**不碰**共享测试库、不经过 truncate / 测试路由，因此它判的就是「启动路径本身」。
 */
const PROBE = join(process.cwd(), "tests", "helpers", "ormInitProbe.ts");

interface RuleRow {
    type: string;
    name: string;
    priority: number;
    source: string;
    biz_id: string;
    note: string | null;
    config: string;
    tenant_id: number;
    cross_tenant: number;
    enabled: number;
}

describe("起步接线：全新库跑 ormService.init() 后系统规则已就位", () => {
    it("init 一次之后，rule 表里四条系统规则齐全且字段/开关初值与常量、配置一致", () => {
        const dir = mkdtempSync(join(tmpdir(), "gw-system-rules-init-"));
        const dbPath = join(dir, "fresh.db");

        try {
            const probe = spawnSync("npx", ["tsx", PROBE, dbPath], {
                encoding: "utf8",
                timeout: 120000,
                env: {
                    ...process.env,
                    // 本用例刻意锁 sqlite：MySQL 门里也会收集 *.node.test.ts，若跟随 DB_DRIVER
                    // 就会去连共享 MySQL 库，反而测不到「新库启动」（断言侧读的是这个空库文件）
                    DB_DRIVER: "sqlite",
                    TEST_MODE: "node",
                },
            });

            expect(probe.error, `探针启动失败：${String(probe.error)}`).toBeUndefined();
            expect(probe.stderr, `探针 stderr：${probe.stderr}`).not.toContain("ORM_INIT_FAILED");
            expect(probe.status, `探针退出码 ${String(probe.status)}，stderr=${probe.stderr}`).toBe(0);
            expect(probe.stdout).toContain("ORM_INIT_OK");

            const db = new Database(dbPath, { readonly: true });
            try {
                const rows = db.prepare(
                    "SELECT type, name, priority, source, biz_id, note, config, tenant_id, cross_tenant, enabled"
                    + " FROM rule WHERE source = 'system' ORDER BY priority ASC",
                ).all() as RuleRow[];

                // 没有这一条，删掉 init 里的 ensure 也会「通过」——这正是本次要补的判据
                expect(rows).toHaveLength(SYSTEM_PLUGIN_RULES.length);

                const configValues = db.prepare("SELECT name, value FROM config").all() as { name: string; value: string }[];
                const configMap = new Map(configValues.map((row) => [row.name, row.value]));

                for (const definition of SYSTEM_PLUGIN_RULES) {
                    const row = rows.find((item) => item.biz_id === definition.bizId);
                    expect(row, `系统规则 ${definition.bizId} 在全新库启动后不存在`).toBeDefined();

                    expect(row!.type).toBe("plugin");
                    expect(row!.name).toBe(definition.name);
                    expect(row!.priority).toBe(definition.priority);
                    expect(row!.note).toBe(definition.note);
                    expect(row!.note, "note 是用户可见文案，不能为空").toBeTruthy();
                    expect(JSON.parse(row!.config)).toEqual({
                        plugin: definition.plugin,
                        pluginConfig: definition.pluginConfig,
                    });
                    // 系统规则只挂 main 租户、跨租户共享
                    expect(row!.tenant_id).toBe(1);
                    expect(row!.cross_tenant).toBe(1);

                    // enabled 取配置当前值（无配置行则取后端默认值）——不是硬编码 true
                    const raw = configMap.has(definition.configKey)
                        ? configMap.get(definition.configKey)!
                        : configService.getConfigDefault(definition.configKey);
                    expect(
                        Boolean(row!.enabled),
                        `${definition.bizId} 的 enabled 应等于配置 ${definition.configKey}=${raw}`,
                    ).toBe(raw === "true");
                }

                // 迁移确实跑了（否则上面读 rule 表就直接报 no such table，留一条正向证据）
                const migrations = db.prepare("SELECT name FROM _migrations").all() as { name: string }[];
                expect(migrations.length).toBeGreaterThan(0);
            } finally {
                db.close();
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 180000);
});
