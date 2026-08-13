import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SgVendor, SgVendorConfig } from "../../src/model/sgVendor";
import vendorManager from "../../src/manager/vendorManager";
import vendorModelManager from "../../src/manager/vendorModelManager";
import dbHelper from "../helpers/dbHelper";
import ormTestHelper from "../helpers/ormTestHelper";


describe("vendorModelManager (node, real db)", () => {
    beforeAll(async () => {
        await ormTestHelper.connectNodeOrm();
    });

    beforeEach(async () => {
        await dbHelper.truncate();
    });

    async function createVendor() {
        return await vendorManager.create(new SgVendor({
            type: "openai",
            name: `v-${Math.random()}`,
            token: "sk-test",
            urls: {},
            config: new SgVendorConfig({}),
        }));
    }

    it("vendorModelManager add rejects duplicate", async () => {
        const vendor = await createVendor();
        await vendorModelManager.add(vendor.id, "gpt-4o");

        await expect(vendorModelManager.add(vendor.id, "gpt-4o"))
            .rejects.toThrow("Model already exists");
    });

    it("listByVendor / update / remove / getByIds", async () => {
        const vendor = await createVendor();
        const vm1 = await vendorModelManager.create(vendor.id, "gpt-4o");
        await vendorModelManager.create(vendor.id, "gpt-4o-mini");

        const list = await vendorModelManager.listByVendor(vendor.id);
        expect(list.length).toBe(2);

        const updated = await vendorModelManager.update(vm1.id, vendor.id, JSON.stringify(["openai"]));
        expect(updated?.allowed_formats).toBe(JSON.stringify(["openai"]));

        const byIds = await vendorModelManager.getByIds([vm1.id]);
        expect(byIds.length).toBe(1);

        expect(await vendorModelManager.remove(vm1.id, vendor.id)).toBe(true);
        expect((await vendorModelManager.listByVendor(vendor.id)).length).toBe(1);
        // 记录不属于该 vendor 时删除失败
        const other = await vendorModelManager.create(999, "x");
        expect(await vendorModelManager.remove(other.id, vendor.id)).toBe(false);
    });

    it("syncByVendor replaces the full set", async () => {
        const vendor = await createVendor();
        await vendorModelManager.create(vendor.id, "gpt-4o");

        const synced = await vendorModelManager.syncByVendor(vendor.id, ["claude-3-5-sonnet"]);
        expect(synced.length).toBe(1);
        expect(synced[0].model_id).toBe("claude-3-5-sonnet");
    });

    it("findById + findByVendorAndModel + create", async () => {
        const vendor = await createVendor();
        const vm = await vendorModelManager.create(vendor.id, "gpt-4o");

        expect((await vendorModelManager.findById(vm.id))?.model_id).toBe("gpt-4o");
        expect(await vendorModelManager.findById(999999)).toBeNull();

        expect((await vendorModelManager.findByVendorAndModel(vendor.id, "gpt-4o"))?.id).toBe(vm.id);
        expect(await vendorModelManager.findByVendorAndModel(vendor.id, "missing")).toBeNull();
        expect(await vendorModelManager.findByVendorAndModel(vendor.id, null)).toBeNull();
    });

    it("update returns null when record does not belong to vendor", async () => {
        const vendorA = await createVendor();
        const vendorB = await createVendor();
        const vm = await vendorModelManager.create(vendorA.id, "gpt-4o");

        expect(await vendorModelManager.update(vm.id, vendorB.id, '["anthropic"]')).toBeNull();
        expect(await vendorModelManager.update(999999, vendorA.id, '["anthropic"]')).toBeNull();
    });

    it("getByIds: empty returns []", async () => {
        expect(await vendorModelManager.getByIds([])).toEqual([]);
        const vendor = await createVendor();
        const vm = await vendorModelManager.create(vendor.id, "gpt-4o");
        expect((await vendorModelManager.getByIds([vm.id])).length).toBe(1);
    });

    it("findVendorModel returns null when missing", async () => {
        const vendor = await createVendor();
        expect(await vendorModelManager.findVendorModel(999999, vendor.id)).toBeNull();
    });
});
