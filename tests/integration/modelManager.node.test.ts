import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SgModel } from "../../src/model/sgModel";
import { ModelRoutingMode } from "../../src/constants";
import modelManager from "../../src/manager/modelManager";
import dbHelper from "../helpers/dbHelper";
import ormTestHelper from "../helpers/ormTestHelper";


describe("modelManager (node, real db)", () => {
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

    it("save + findById + getModel + listModels", async () => {
        const model = await modelManager.save(buildModel("gpt-4o"));

        expect((await modelManager.findById(model.id))?.name).toBe("gpt-4o");
        expect((await modelManager.getModel("gpt-4o"))?.id).toBe(model.id);
        expect(await modelManager.getModel("missing")).toBeNull();

        const { list, total } = await modelManager.listModels({ pageSize: 10, offset: 0 });
        expect(total).toBe(1);
        expect(list.length).toBe(1);
    });

    it("checkDuplicateEnabledModel + deleteModel", async () => {
        const model = await modelManager.save(buildModel("gpt-4o"));

        expect(await modelManager.checkDuplicateEnabledModel("gpt-4o")).toBe(true);
        expect(await modelManager.checkDuplicateEnabledModel("gpt-4o", model.id)).toBe(false);

        expect(await modelManager.deleteModel(model.id)).toBe(true);
        expect(await modelManager.findById(model.id)).toBeNull();
        expect(await modelManager.deleteModel(model.id)).toBe(false);
    });

    it("getModel with enable filter", async () => {
        const model = await modelManager.save(buildModel("gpt-4o"));
        expect((await modelManager.getModel("gpt-4o", true))?.id).toBe(model.id);
        expect(await modelManager.getModel("gpt-4o", false)).toBeNull();
        expect(await modelManager.getModel(null as any)).toBeNull();
    });

    it("getByIds: empty returns [], non-empty returns models", async () => {
        expect(await modelManager.getByIds([])).toEqual([]);
        const m1 = await modelManager.save(buildModel("m1"));
        const m2 = await modelManager.save(buildModel("m2"));
        const models = await modelManager.getByIds([m1.id, m2.id]);
        expect(models.length).toBe(2);
    });

    it("listModels: keyword filter", async () => {
        await modelManager.save(buildModel("alpha-one"));
        await modelManager.save(buildModel("beta-two"));
        const { total } = await modelManager.listModels({ keyword: "alpha", pageSize: 10, offset: 0 });
        expect(total).toBe(1);
    });

    it("listModels: vendorId filter", async () => {
        await modelManager.save(buildModel("with-vendor"));
        const { total } = await modelManager.listModels({ vendorId: 1, pageSize: 10, offset: 0 });
        expect(total).toBe(1);
        const { total: none } = await modelManager.listModels({ vendorId: 999, pageSize: 10, offset: 0 });
        expect(none).toBe(0);
    });

    it("hasModelsUsingVendor", async () => {
        await modelManager.save(buildModel("with-vendor"));
        expect(await modelManager.hasModelsUsingVendor(1)).toBe(true);
        expect(await modelManager.hasModelsUsingVendor(999)).toBe(false);
    });

    it("listEnabledModels returns formatted model list", async () => {
        await modelManager.save(buildModel("enabled-model"));
        const list = await modelManager.listEnabledModels();
        expect(list.length).toBe(1);
        expect(list[0].id).toBe("enabled-model");
        expect(list[0].object).toBe("model");
        expect(list[0].owned_by).toBe("gateway");
    });

    it("count", async () => {
        expect(await modelManager.count()).toBe(0);
        await modelManager.save(buildModel("count-me"));
        expect(await modelManager.count()).toBe(1);
    });
});
