import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import userManager from "../../src/manager/userManager";
import dbHelper from "../helpers/dbHelper";
import ormTestHelper from "../helpers/ormTestHelper";


describe("userManager (node, real db)", () => {
    beforeAll(async () => {
        await ormTestHelper.connectNodeOrm();
    });

    beforeEach(async () => {
        await dbHelper.truncate();
    });

    async function createUser(name = "tester") {
        return await userManager.create({
            name,
            token: `token-${Math.random()}`,
            type: "normal" as any,
        });
    }

    it("create + findByToken + findById", async () => {
        const user = await createUser();

        expect((await userManager.findByToken(user.token))?.id).toBe(user.id);
        expect((await userManager.findByToken(null as any))).toBeNull();
        expect((await userManager.findById(user.id))?.name).toBe("tester");
    });

    it("update + incrementBalance", async () => {
        const user = await createUser();

        const updated = await userManager.update(user.id, { name: "renamed" });
        expect(updated?.name).toBe("renamed");

        // incrementBalance 为原子增量，可从 0 累加（含扣成负）
        await userManager.incrementBalance(user.id, 1_000_000);
        expect((await userManager.findById(user.id))?.balance).toBe(1_000_000);

        await userManager.incrementBalance(user.id, -2_000_000);
        expect((await userManager.findById(user.id))?.balance).toBe(-1_000_000);
    });

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

    it("list on empty table returns total 0", async () => {
        // 空表：count() 返回 0，走 `|| 0` 兜底分支
        const { list, total } = await userManager.list({ pageSize: 10, offset: 0 });
        expect(total).toBe(0);
        expect(list.length).toBe(0);
    });
});
