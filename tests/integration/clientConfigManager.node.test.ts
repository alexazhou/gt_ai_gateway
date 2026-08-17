import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import clientConfigManager from "../../src/manager/clientConfigManager";
import dbHelper from "../helpers/dbHelper";
import ormTestHelper from "../helpers/ormTestHelper";


describe("clientConfigManager (node, real db)", () => {
    beforeAll(async () => {
        await ormTestHelper.connectNodeOrm();
    });

    beforeEach(async () => {
        await dbHelper.truncate();
    });

    async function createConfig(name: string, client: string = "codex") {
        return await clientConfigManager.create({
            client,
            name,
            configContent: {
                gatewayUrl: "http://localhost:8720",
                apiKey: "sk-test",
                model: "gpt-4o",
            },
            enabled: false,
        });
    }

    it("listByClient orders by id asc by default", async () => {
        const c1 = await createConfig("a");
        const c2 = await createConfig("b");
        const list = await clientConfigManager.listByClient("codex");
        expect(list.map(c => c.id)).toEqual([c1.id, c2.id]);
    });

    it("listByClient with orderByIdAsc=false (no explicit order)", async () => {
        await createConfig("a");
        await createConfig("b");
        const list = await clientConfigManager.listByClient("codex", false);
        // orderByIdAsc=false 时不附加 orderBy，顺序由数据库决定，只验证条数
        expect(list.length).toBe(2);
    });

    it("listByClient filters by client", async () => {
        await createConfig("a", "codex");
        await createConfig("b", "cli");
        expect((await clientConfigManager.listByClient("codex")).length).toBe(1);
    });

    it("findByIdAndClient returns record or null", async () => {
        const cfg = await createConfig("a");
        expect((await clientConfigManager.findByIdAndClient(cfg.id, "codex"))?.name).toBe("a");
        expect(await clientConfigManager.findByIdAndClient(cfg.id, "other")).toBeNull();
        expect(await clientConfigManager.findByIdAndClient(99999, "codex")).toBeNull();
    });

    it("update + remove", async () => {
        const cfg = await createConfig("a");
        const updated = await clientConfigManager.update(cfg, { name: "renamed" });
        expect(updated.name).toBe("renamed");

        await clientConfigManager.remove(updated);
        expect(await clientConfigManager.findByIdAndClient(updated.id, "codex")).toBeNull();
    });

    it("disableAllByClient", async () => {
        const c1 = await createConfig("a");
        await createConfig("b");
        // client_config 唯一约束允许同一 client 只有一条 enabled=1 的记录
        await clientConfigManager.update(c1, { enabled: true });
        expect((await clientConfigManager.listByClient("codex")).some(c => c.enabled)).toBe(true);

        await clientConfigManager.disableAllByClient("codex");
        const list = await clientConfigManager.listByClient("codex");
        expect(list.every(c => !c.enabled)).toBe(true);
    });

    it("formatUniqueName: base not taken returns base", async () => {
        await createConfig("existing");
        expect(await clientConfigManager.formatUniqueName("codex", "fresh")).toBe("fresh");
    });

    it("formatUniqueName: appends incrementing suffix", async () => {
        await createConfig("cfg");
        await createConfig("cfg1");
        await createConfig("cfg2");
        expect(await clientConfigManager.formatUniqueName("codex", "cfg")).toBe("cfg3");
    });
});
