import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SgModel } from "../../src/model/sgModel";
import { SgVendor, SgVendorConfig } from "../../src/model/sgVendor";
import { ModelRoutingMode, SgRecordStatus } from "../../src/constants";
import clientConfigManager from "../../src/manager/clientConfigManager";
import storageManager, { normalizeBytes, toDatabaseBytes } from "../../src/manager/storageManager";
import modelManager from "../../src/manager/modelManager";
import recordManager from "../../src/manager/recordManager";
import userManager from "../../src/manager/userManager";
import vendorManager from "../../src/manager/vendorManager";
import vendorModelManager from "../../src/manager/vendorModelManager";
import dbHelper from "../helpers/dbHelper";
import ormTestHelper from "../helpers/ormTestHelper";


/**
 * 补充 manager 层覆盖率：覆盖 clientConfigManager / storageManager 全量，
 * 以及其余 manager 中未覆盖的分支与查询条件。
 */
describe("manager layer coverage (node, real db)", () => {
    beforeAll(async () => {
        await ormTestHelper.connectNodeOrm();
    });

    beforeEach(async () => {
        await dbHelper.truncate();
    });

    describe("clientConfigManager", () => {
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

    describe("storageManager", () => {
        it("putToTable create + getFromTable roundtrip", async () => {
            await storageManager.putToTable("k1", new Uint8Array([1, 2, 3]));
            const obj = await storageManager.getFromTable("k1");
            expect(obj?.object_key).toBe("k1");
            expect(obj?.size_bytes).toBe(3);
            expect(Array.from(obj!.data)).toEqual([1, 2, 3]);
        });

        it("putToTable updates existing row", async () => {
            await storageManager.putToTable("k1", new Uint8Array([1, 2, 3]));
            await storageManager.putToTable("k1", new Uint8Array([9, 8]));
            const obj = await storageManager.getFromTable("k1");
            expect(obj?.size_bytes).toBe(2);
            expect(Array.from(obj!.data)).toEqual([9, 8]);
        });

        it("getFromTable returns null for missing key", async () => {
            expect(await storageManager.getFromTable("missing")).toBeNull();
        });

        it("deleteFromTable + deleteFromTableByPrefix", async () => {
            await storageManager.putToTable("prefix-a", new Uint8Array([1]));
            await storageManager.putToTable("prefix-b", new Uint8Array([2]));
            await storageManager.putToTable("other-c", new Uint8Array([3]));

            const deleted = await storageManager.deleteFromTableByPrefix("prefix-");
            expect(deleted).toBe(2);
            expect(await storageManager.getFromTable("prefix-a")).toBeNull();
            expect(await storageManager.getFromTable("other-c")).not.toBeNull();

            await storageManager.deleteFromTable("other-c");
            expect(await storageManager.getFromTable("other-c")).toBeNull();
        });

        it("deleteFromTableByPrefix with no matches returns 0", async () => {
            expect(await storageManager.deleteFromTableByPrefix("nope-")).toBe(0);
        });
    });

    describe("normalizeBytes", () => {
        it("handles Uint8Array", () => {
            expect(normalizeBytes(new Uint8Array([1, 2]))).toEqual(new Uint8Array([1, 2]));
        });

        it("handles ArrayBuffer", () => {
            expect(normalizeBytes(new ArrayBuffer(2))).toEqual(new Uint8Array(2));
        });

        it("handles other TypedArray / DataView", () => {
            expect(normalizeBytes(new Uint16Array([1, 2]))).toEqual(new Uint8Array([1, 0, 2, 0]));
            const dv = new DataView(new ArrayBuffer(2));
            expect(normalizeBytes(dv)).toEqual(new Uint8Array(2));
        });

        it("handles string via TextEncoder", () => {
            expect(normalizeBytes("hi")).toEqual(new Uint8Array([104, 105]));
        });

        it("handles D1 Buffer serialized object", () => {
            expect(normalizeBytes({ type: "Buffer", data: [1, 2, 3] })).toEqual(new Uint8Array([1, 2, 3]));
        });

        it("handles duck-typed buffer-like object", () => {
            const buf = new ArrayBuffer(2);
            expect(normalizeBytes({ buffer: buf, byteOffset: 0, byteLength: 2 })).toEqual(new Uint8Array(2));
        });

        it("handles plain array", () => {
            expect(normalizeBytes([1, 2, 3])).toEqual(new Uint8Array([1, 2, 3]));
        });

        it("handles number as single byte", () => {
            expect(normalizeBytes(7)).toEqual(new Uint8Array([7]));
        });

        it("handles null / undefined as empty", () => {
            expect(normalizeBytes(null)).toEqual(new Uint8Array(0));
            expect(normalizeBytes(undefined)).toEqual(new Uint8Array(0));
        });

        it("throws on unsupported type", () => {
            expect(() => normalizeBytes({})).toThrow();
            expect(() => normalizeBytes(true)).toThrow();
        });

        it("toDatabaseBytes returns Buffer when available", () => {
            const result = toDatabaseBytes(new Uint8Array([1, 2, 3]));
            expect(result).toBeInstanceOf(Uint8Array);
            expect(Array.from(result)).toEqual([1, 2, 3]);
        });

        it("toDatabaseBytes falls back to raw data when Buffer is undefined", () => {
            const originalBuffer = (globalThis as any).Buffer;
            (globalThis as any).Buffer = undefined;
            try {
                const input = new Uint8Array([4, 5]);
                const result = toDatabaseBytes(input);
                expect(result).toBe(input);
            } finally {
                (globalThis as any).Buffer = originalBuffer;
            }
        });
    });

    describe("userManager coverage", () => {
        async function createUser(name = "tester") {
            return await userManager.create({
                name,
                token: `token-${Math.random()}`,
                type: "normal" as any,
            });
        }

        it("getByIds: empty returns [], non-empty returns users", async () => {
            expect(await userManager.getByIds([])).toEqual([]);

            const u1 = await createUser("u1");
            const u2 = await createUser("u2");
            const users = await userManager.getByIds([u1.id, u2.id]);
            expect(users.length).toBe(2);
            expect(users.map(u => u.name)).toContain("u1");
        });

        it("list: no filter returns all, ordered by id desc", async () => {
            const u1 = await createUser("a");
            const u2 = await createUser("b");
            const { list, total } = await userManager.list({ pageSize: 10, offset: 0 });
            expect(total).toBe(2);
            expect(list[0].id).toBe(u2.id);
            expect(list[1].id).toBe(u1.id);
        });

        it("list: type filter", async () => {
            await createUser("normal-user");
            await userManager.create({ name: "admin-user", token: "t-admin", type: "admin" as any });
            const { total } = await userManager.list({ type: "admin", pageSize: 10, offset: 0 });
            expect(total).toBe(1);
        });

        it("list: keyword filter on name", async () => {
            await createUser("alice");
            await createUser("bob");
            const { total } = await userManager.list({ keyword: "ali", pageSize: 10, offset: 0 });
            expect(total).toBe(1);
        });

        it("list: pagination offset", async () => {
            await createUser("a");
            await createUser("b");
            const { list, total } = await userManager.list({ pageSize: 1, offset: 1 });
            expect(total).toBe(2);
            expect(list.length).toBe(1);
        });

        it("count", async () => {
            expect(await userManager.count()).toBe(0);
            await createUser();
            expect(await userManager.count()).toBe(1);
        });
    });

    describe("modelManager coverage", () => {
        function buildModel(name: string) {
            return new SgModel({
                name,
                routing_mode: ModelRoutingMode.SINGLE,
                routing_config: {
                    upstreams: [{ vendor_id: 1, enabled: true }],
                    failover: { enabled: true },
                },
            });
        }

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

    describe("recordManager coverage", () => {
        async function buildModel(name: string) {
            return await modelManager.save(new SgModel({
                name,
                routing_mode: ModelRoutingMode.SINGLE,
                routing_config: {
                    upstreams: [{ vendor_id: 1, enabled: true }],
                    failover: { enabled: true },
                },
            }));
        }

        async function createUser() {
            return await userManager.create({
                name: "tester",
                token: `token-${Math.random()}`,
                type: "normal" as any,
            });
        }

        async function createRecord(status = SgRecordStatus.SUCCESS) {
            const user = await createUser();
            const model = await buildModel(`m-${Math.random()}`);
            return await recordManager.create({
                user_id: user.id,
                model_id: model.id,
                vendor_id: null,
                vendor_model_name: null,
                status,
                client_format: null,
                upstream_format: null,
                first_token_latency: null,
                start_at: new Date(),
                end_at: null,
                cost: 0,
            });
        }

        it("update writes table columns", async () => {
            const record = await createRecord(SgRecordStatus.INIT);
            await recordManager.update(record.id, {
                status: SgRecordStatus.SUCCESS,
                cost: 42,
            });
            const refreshed = await recordManager.findById(record.id);
            expect(refreshed?.status).toBe(SgRecordStatus.SUCCESS);
            expect(refreshed?.cost).toBe(42);
        });

        it("latest with summaryOnly selects summary columns", async () => {
            await createRecord();
            const rows = await recordManager.latest(10, true);
            expect(rows.length).toBe(1);
        });

        it("list filters by status / time / userIds / modelIds", async () => {
            const user = await createUser();
            const model = await buildModel("m-filter");
            const record = await recordManager.create({
                user_id: user.id,
                model_id: model.id,
                vendor_id: null,
                vendor_model_name: null,
                status: SgRecordStatus.SUCCESS,
                client_format: null,
                upstream_format: null,
                first_token_latency: null,
                start_at: new Date(),
                end_at: null,
                cost: 0,
            });

            expect((await recordManager.list({ status: SgRecordStatus.SUCCESS, pageSize: 10, offset: 0 })).total).toBe(1);
            expect((await recordManager.list({ status: SgRecordStatus.FAILED, pageSize: 10, offset: 0 })).total).toBe(0);

            // 时间过滤使用记录实际的 created_at（数据库存储为本地时间字符串 "YYYY-MM-DD HH:MM:SS"）
            const refreshed = await recordManager.findById(record.id);
            const createdAtDate = refreshed?.created_at as Date;
            const pad = (n: number) => String(n).padStart(2, "0");
            const createdAt = `${createdAtDate.getFullYear()}-${pad(createdAtDate.getMonth() + 1)}-${pad(createdAtDate.getDate())} ${pad(createdAtDate.getHours())}:${pad(createdAtDate.getMinutes())}:${pad(createdAtDate.getSeconds())}`;
            expect((await recordManager.list({ startTime: createdAt, pageSize: 10, offset: 0 })).total).toBe(1);
            expect((await recordManager.list({ endTime: createdAt, pageSize: 10, offset: 0 })).total).toBe(1);
            expect((await recordManager.list({ startTime: "2099-01-01 00:00:00", pageSize: 10, offset: 0 })).total).toBe(0);

            expect((await recordManager.list({ userIds: [user.id], pageSize: 10, offset: 0 })).total).toBe(1);
            expect((await recordManager.list({ userIds: [999999], pageSize: 10, offset: 0 })).total).toBe(0);
            expect((await recordManager.list({ modelIds: [model.id], pageSize: 10, offset: 0 })).total).toBe(1);
            expect((await recordManager.list({ modelIds: [999999], pageSize: 10, offset: 0 })).total).toBe(0);
        });

        it("list with summaryOnly + recent + deleteAll", async () => {
            await createRecord();
            const summarized = await recordManager.list({ pageSize: 10, offset: 0, summaryOnly: true });
            expect(summarized.total).toBe(1);

            const recent = await recordManager.recent(5);
            expect(recent.length).toBe(1);

            await recordManager.deleteAll();
            expect(await recordManager.count()).toBe(0);
        });
    });

    describe("vendorManager coverage", () => {
        async function createVendor(name = `v-${Math.random()}`) {
            return await vendorManager.create(new SgVendor({
                type: "openai",
                name,
                token: "sk-test",
                urls: {},
                config: new SgVendorConfig({}),
            }));
        }

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
    });

    describe("vendorModelManager coverage", () => {
        async function createVendor() {
            return await vendorManager.create(new SgVendor({
                type: "openai",
                name: `v-${Math.random()}`,
                token: "sk-test",
                urls: {},
                config: new SgVendorConfig({}),
            }));
        }

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

            expect(await vendorModelManager.update(vm.id, vendorB.id, "[\"anthropic\"]")).toBeNull();
            expect(await vendorModelManager.update(999999, vendorA.id, "[\"anthropic\"]")).toBeNull();
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
});
