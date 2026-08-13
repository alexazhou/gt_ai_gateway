import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SgVendor, SgVendorConfig } from "../../src/model/sgVendor";
import vendorManager from "../../src/manager/vendorManager";
import vendorModelManager from "../../src/manager/vendorModelManager";
import dbHelper from "../helpers/dbHelper";
import ormTestHelper from "../helpers/ormTestHelper";


describe("vendorManager (node, real db)", () => {
    beforeAll(async () => {
        await ormTestHelper.connectNodeOrm();
    });

    beforeEach(async () => {
        await dbHelper.truncate();
    });

    async function createVendor(name = `v-${Math.random()}`) {
        return await vendorManager.create(new SgVendor({
            type: "openai",
            name,
            token: "sk-test",
            urls: {},
            config: new SgVendorConfig({}),
        }));
    }

    it("create + findById + findByName + listAll", async () => {
        const vendor = await createVendor();

        expect((await vendorManager.findById(vendor.id))?.name).toBe(vendor.name);
        expect((await vendorManager.findByName(vendor.name))?.id).toBe(vendor.id);
        expect((await vendorManager.findByName("missing"))).toBeNull();
        expect((await vendorManager.listAll()).length).toBe(1);
    });

    it("list returns modelCounts per vendor", async () => {
        const vendor = await createVendor();
        await vendorModelManager.create(vendor.id, "gpt-4o");
        await vendorModelManager.create(vendor.id, "gpt-4o-mini");

        const { list, total, modelCounts } = await vendorManager.list({ pageSize: 10, offset: 0 });
        expect(total).toBe(1);
        expect(list.length).toBe(1);
        expect(modelCounts[vendor.id]).toBe(2);
    });

    it("update + deleteById", async () => {
        const vendor = await createVendor();
        const updated = await vendorManager.update(vendor.id, { name: "renamed" });
        expect(updated?.name).toBe("renamed");

        expect(await vendorManager.deleteById(vendor.id)).toBe(true);
        expect(await vendorManager.findById(vendor.id)).toBeNull();
        expect(await vendorManager.deleteById(vendor.id)).toBe(false);
    });

    it("findByName handles null", async () => {
        expect(await vendorManager.findByName(null as any)).toBeNull();
        const vendor = await createVendor();
        expect((await vendorManager.findByName(vendor.name))?.id).toBe(vendor.id);
    });

    it("list filters by type and keyword", async () => {
        await createVendor("alpha-vendor");
        await createVendor("beta-vendor");

        const byType = await vendorManager.list({ type: "openai", pageSize: 10, offset: 0 });
        expect(byType.total).toBe(2);

        const byKeyword = await vendorManager.list({ keyword: "alpha", pageSize: 10, offset: 0 });
        expect(byKeyword.total).toBe(1);
    });

    it("getByIds: empty returns [], non-empty returns vendors", async () => {
        expect(await vendorManager.getByIds([])).toEqual([]);
        const v1 = await createVendor();
        const v2 = await createVendor();
        const vendors = await vendorManager.getByIds([v1.id, v2.id]);
        expect(vendors.length).toBe(2);
    });

    it("count", async () => {
        expect(await vendorManager.count()).toBe(0);
        await createVendor();
        expect(await vendorManager.count()).toBe(1);
    });

    it("list on empty table returns total 0 and empty modelCounts", async () => {
        // 空表：count() 返回 0（`|| 0` 兜底），且 vendorIds 为空列表跳过聚合查询
        const { list, total, modelCounts } = await vendorManager.list({ pageSize: 10, offset: 0 });
        expect(total).toBe(0);
        expect(list.length).toBe(0);
        expect(Object.keys(modelCounts).length).toBe(0);
    });
});
