import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SgModel } from "../../src/model/sgModel";
import { SgVendor, SgVendorConfig } from "../../src/model/sgVendor";
import { ModelRoutingMode, SgRecordStatus } from "../../src/constants";
import configManager from "../../src/manager/configManager";
import modelManager from "../../src/manager/modelManager";
import rechargeRecordManager from "../../src/manager/rechargeRecordManager";
import recordManager from "../../src/manager/recordManager";
import requestActivityManager from "../../src/manager/requestActivityManager";
import userManager from "../../src/manager/userManager";
import vendorManager from "../../src/manager/vendorManager";
import vendorModelManager from "../../src/manager/vendorModelManager";
import dbHelper from "../helpers/dbHelper";
import ormTestHelper from "../helpers/ormTestHelper";


describe("manager layer (node, real db)", () => {
    beforeAll(async () => {
        await ormTestHelper.connectNodeOrm();
    });

    beforeEach(async () => {
        await dbHelper.truncate();
    });

    describe("rechargeRecordManager", () => {
        async function createTestUser() {
            return await userManager.create({
                name: "tester",
                token: `token-${Math.random()}`,
                type: "normal" as any,
            });
        }

        it("create + listRechargeRecords + getRechargeRecord", async () => {
            const user = await createTestUser();
            await rechargeRecordManager.create({
                user_id: user.id,
                amount: 100,
                type: "recharge",
                remark: "充值",
                operator: "admin",
            });

            const { list, total } = await rechargeRecordManager.listRechargeRecords({ user_id: user.id });
            expect(total).toBe(1);
            expect(list.length).toBe(1);
            expect(list[0].amount).toBe(100);

            const record = await rechargeRecordManager.getRechargeRecord(Number(list[0].id));
            expect(record?.remark).toBe("充值");
        });

        it("listRechargeRecords filters by type", async () => {
            const user = await createTestUser();
            await rechargeRecordManager.create({ user_id: user.id, amount: 10, type: "recharge" });
            await rechargeRecordManager.create({ user_id: user.id, amount: -5, type: "adjustment" });

            const recharge = await rechargeRecordManager.listRechargeRecords({ user_id: user.id, type: "recharge" });
            expect(recharge.total).toBe(1);
            expect(recharge.list[0].amount).toBe(10);
        });
    });

    describe("vendorManager + vendorModelManager", () => {
        async function createVendor() {
            return await vendorManager.create(new SgVendor({
                type: "openai",
                name: "test-vendor",
                token: "sk-test",
                urls: {},
                config: new SgVendorConfig({}),
            }));
        }

        it("create + findById + findByName + listAll", async () => {
            const vendor = await createVendor();

            expect((await vendorManager.findById(vendor.id))?.name).toBe("test-vendor");
            expect((await vendorManager.findByName("test-vendor"))?.id).toBe(vendor.id);
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

        it("vendorModelManager add rejects duplicate", async () => {
            const vendor = await createVendor();
            await vendorModelManager.add(vendor.id, "gpt-4o");

            await expect(vendorModelManager.add(vendor.id, "gpt-4o"))
                .rejects.toThrow("Model already exists");
        });

        it("vendorModelManager listByVendor / update / remove / getByIds", async () => {
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

        it("vendorModelManager syncByVendor replaces the full set", async () => {
            const vendor = await createVendor();
            await vendorModelManager.create(vendor.id, "gpt-4o");

            const synced = await vendorModelManager.syncByVendor(vendor.id, ["claude-3-5-sonnet"]);
            expect(synced.length).toBe(1);
            expect(synced[0].model_id).toBe("claude-3-5-sonnet");
        });
    });

    describe("userManager", () => {
        it("create + findByToken + findById", async () => {
            const user = await userManager.create({
                name: "tester",
                token: "token-abc",
                type: "normal" as any,
            });

            expect((await userManager.findByToken("token-abc"))?.id).toBe(user.id);
            expect((await userManager.findByToken(null as any))).toBeNull();
            expect((await userManager.findById(user.id))?.name).toBe("tester");
        });

        it("update + updateBalance", async () => {
            const user = await userManager.create({
                name: "tester",
                token: "token-abc",
                type: "normal" as any,
            });

            const updated = await userManager.update(user.id, { name: "renamed" });
            expect(updated?.name).toBe("renamed");

            await userManager.updateBalance(user.id, 1_000_000);
            expect((await userManager.findById(user.id))?.balance).toBe(1_000_000);
        });
    });

    describe("modelManager", () => {
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
    });

    describe("recordManager", () => {
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

        async function createTestUser() {
            return await userManager.create({
                name: "tester",
                token: `token-${Math.random()}`,
                type: "normal" as any,
            });
        }

        async function buildRecordData() {
            const user = await createTestUser();
            const model = await modelManager.save(buildModel(`m-${Math.random()}`));
            return { user, model };
        }

        it("create + findById + latest + count + deleteById", async () => {
            const { user, model } = await buildRecordData();
            const record = await recordManager.create({
                user_id: user.id,
                model_id: model.id,
                vendor_id: null,
                vendor_model_name: null,
                status: SgRecordStatus.INIT,
                client_format: null,
                upstream_format: null,
                first_token_latency: null,
                start_at: new Date(),
                end_at: null,
                cost: 0,
            });

            expect((await recordManager.findById(record.id))?.status).toBe(SgRecordStatus.INIT);
            expect((await recordManager.latest(10, true)).length).toBe(1);
            expect(await recordManager.count()).toBe(1);

            expect(await recordManager.deleteById(record.id)).toBe(true);
            expect(await recordManager.count()).toBe(0);
            expect(await recordManager.deleteById(record.id)).toBe(false);
        });

        it("update strips response_data (not a table column)", async () => {
            const { user, model } = await buildRecordData();
            const record = await recordManager.create({
                user_id: user.id,
                model_id: model.id,
                vendor_id: null,
                vendor_model_name: null,
                status: SgRecordStatus.INIT,
                client_format: null,
                upstream_format: null,
                first_token_latency: null,
                start_at: new Date(),
                end_at: null,
                cost: 0,
            });

            await recordManager.update(record.id, {
                status: SgRecordStatus.SUCCESS,
                response_data: "should-not-reach-table",
            });

            const refreshed = await recordManager.findById(record.id);
            expect(refreshed?.status).toBe(SgRecordStatus.SUCCESS);
        });
    });

    describe("requestActivityManager", () => {
        it("createActivity + findByRecordId + updateActivities", async () => {
            await requestActivityManager.createActivity(1, "[]");

            const row = await requestActivityManager.findByRecordId(1);
            expect(row?.activities).toBe("[]");

            await requestActivityManager.updateActivities(1, "[{\"stage\":\"result\"}]");
            expect((await requestActivityManager.findByRecordId(1))?.activities).toBe('[{"stage":"result"}]');
        });
    });

    describe("configManager", () => {
        it("set (create) + get + set (update) + getAll", async () => {
            await configManager.set("test_key", "value1");

            expect((await configManager.get("test_key"))?.value).toBe("value1");
            expect(await configManager.get("missing_key")).toBeNull();

            await configManager.set("test_key", "value2");
            expect((await configManager.get("test_key"))?.value).toBe("value2");

            const all = await configManager.getAll();
            const values = Object.fromEntries(all.map(c => [c.name, c.value]));
            expect(values["test_key"]).toBe("value2");
        });
    });
});
