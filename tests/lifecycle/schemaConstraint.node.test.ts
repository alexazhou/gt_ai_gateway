import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SgModel } from "../../src/model/sgModel";
import { ModelRoutingMode } from "../../src/constants";
import modelManager from "../../src/manager/modelManager";
import clientConfigManager from "../../src/manager/clientConfigManager";
import dbHelper from "../helpers/dbHelper";
import ormTestHelper from "../helpers/ormTestHelper";


/**
 * 直接打数据库层（绕过 service 层的查重逻辑）验证唯一约束现状：
 *  - model.name：migrate_0032 已删除 DB 全局唯一索引（跨租户同名模型共存需要），
 *    唯一性移交应用层按租户校验（见 modelService）
 *  - tenant.name / user.token：DB 全局唯一
 *  - client_config：(client, name) 唯一
 */
describe("database uniqueness constraints (node, real db)", () => {
    beforeAll(async () => {
        await ormTestHelper.connectNodeOrm();
    });

    beforeEach(async () => {
        await dbHelper.truncate();
    });

    function buildModel(name: string) {
        return new SgModel({
            name,
            routing_mode: ModelRoutingMode.SINGLE,
            routing_config: {
                upstreams: [{ vendor_id: 1, enabled: true }],
                failover: { enabled: true },
                load_balance_strategy: "user",
            },
        });
    }

    it("model.name 不再 DB 全局唯一：同名字模型在 DB 层可共存（唯一性由应用层按租户查重）", async () => {
        const enabled = await modelManager.save(buildModel("same-name"));
        expect(enabled.enable).toBe(true);

        // migrate_0032 删除了 name_index：DB 层不再拦截同名（跨租户同名模型共存的前提）
        const dup = buildModel("same-name");
        await expect(modelManager.save(dup)).resolves.toBeTruthy();
        expect(await modelManager.count()).toBe(2);
    });

    it("client_config：(client, name) 唯一，不同名或不同 client 允许", async () => {
        await clientConfigManager.create({ client: "claude-code", name: "我的配置", configContent: {}, enabled: false });

        // 同一 client 内重名：被唯一索引拒绝
        await expect(
            clientConfigManager.create({ client: "claude-code", name: "我的配置", configContent: {}, enabled: false }),
        ).rejects.toThrow();

        // 同 client 不同名：允许
        await clientConfigManager.create({ client: "claude-code", name: "另一个配置", configContent: {}, enabled: false });
        // 不同 client 同名：允许
        await clientConfigManager.create({ client: "codex", name: "我的配置", configContent: {}, enabled: false });

        expect((await clientConfigManager.listByClient("claude-code")).length).toBe(2);
        expect((await clientConfigManager.listByClient("codex")).length).toBe(1);
    });
});
