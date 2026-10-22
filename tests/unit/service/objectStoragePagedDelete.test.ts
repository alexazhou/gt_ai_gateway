import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P2-13：R2 前缀删除改「逐页删」。
 *
 * 原实现把所有 key 先收进内存里的 deleteBatches 再统一删 —— 前缀下有几十万对象时
 * 等于把 key 列表全驻留内存（Worker 128MB 很容易顶爆）。现在要求：
 * 1. 内存只驻留一页（list limit 1000 + 每页立即 delete）；
 * 2. 每轮从头部重新 list（边删边推进 cursor 会跳过对象），已删的不再返回，天然收敛；
 * 3. 删除没生效时必须能退出（否则死循环）；
 * 4. 一个对象都没有时返回 0，不发 delete。
 */

const deleteFromTableByPrefixMock = vi.fn(async (_prefix: string) => 0);

// 兜底位置（DB 表）在 deleteByPrefix 里也会被清一遍（存储位置迁移后两边都可能有过数据），
// 这里 mock 掉避免单测碰到真库；返回值单独声明，便于断言「兜底也被清理」。
vi.mock("../../../src/manager/storageManager", () => ({
    default: {
        deleteFromTableByPrefix: (prefix: string) => deleteFromTableByPrefixMock(prefix),
    },
}));

vi.mock("../../../src/service/configService", () => ({
    default: {
        // 强制存储位置 = r2，避免用例依赖运行模式/DB
        getConfig: () => ({ getString: () => "r2", getBoolean: () => true }),
    },
}));

type ListPage = { keys: string[]; truncated: boolean };

class FakeBucket {
    public listCalls: Array<{ limit: number; prefix: string }> = [];
    public deleteCalls: string[][] = [];
    private index = 0;

    constructor(private readonly pages: ListPage[], private readonly onDelete?: (keys: string[]) => void) {}

    async list(options: { limit: number; prefix: string }) {
        this.listCalls.push({ limit: options.limit, prefix: options.prefix });
        const page = this.pages[this.index] ?? { keys: [], truncated: false };
        this.index += 1;
        return {
            objects: page.keys.map(key => ({ key })),
            truncated: page.truncated,
        };
    }

    async delete(keys: string[]) {
        this.deleteCalls.push([...keys]);
        this.onDelete?.(keys);
    }
}

const { default: objectStorageService } = await import("../../../src/service/objectStorageService");

describe("deleteByPrefix 逐页删除（P2-13）", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        deleteFromTableByPrefixMock.mockClear();
    });

    afterEach(() => {
        warnSpy.mockRestore();
        objectStorageService.setR2Bucket(null);
    });

    it("分页时每页立即删，内存不攒全量 key", async () => {
        const bucket = new FakeBucket([
            { keys: ["record/1", "record/2"], truncated: true },
            { keys: ["record/3", "record/4"], truncated: true },
            { keys: ["record/5"], truncated: false },
        ]);
        objectStorageService.setR2Bucket(bucket as any);

        const deleted = await objectStorageService.deleteByPrefix("record/");

        expect(deleted).toBe(5);
        expect(bucket.deleteCalls, "必须每页删一次（而不是攒完再删）").toEqual([
            ["record/1", "record/2"],
            ["record/3", "record/4"],
            ["record/5"],
        ]);
        expect(bucket.listCalls.every(call => call.limit === 1000), "单页上限 1000").toBe(true);
        expect(bucket.listCalls.every(call => call.prefix === "record/")).toBe(true);
        expect(deleteFromTableByPrefixMock, "兜底位置（DB 表）也要按前缀清一遍").toHaveBeenCalledWith("record/");
    });

    it("单页且未截断：删一次就结束，不会多 list 一轮", async () => {
        const bucket = new FakeBucket([{ keys: ["record/9"], truncated: false }]);
        objectStorageService.setR2Bucket(bucket as any);

        expect(await objectStorageService.deleteByPrefix("record/")).toBe(1);
        expect(bucket.listCalls).toHaveLength(1);
        expect(bucket.deleteCalls).toHaveLength(1);
    });

    it("前缀下没有对象：返回 0，不调用 delete", async () => {
        const bucket = new FakeBucket([{ keys: [], truncated: false }]);
        objectStorageService.setR2Bucket(bucket as any);

        expect(await objectStorageService.deleteByPrefix("record/")).toBe(0);
        expect(bucket.deleteCalls).toHaveLength(0);
    });

    it("删除未生效（每轮都返回同一批 key）时提前退出，不死循环", async () => {
        // truncated 永远 true、delete 不生效 → 第二轮首 key 与上一轮相同
        const bucket = new FakeBucket(
            [
                { keys: ["record/1", "record/2"], truncated: true },
                { keys: ["record/1", "record/2"], truncated: true },
                { keys: ["record/1", "record/2"], truncated: true },
            ],
        );
        objectStorageService.setR2Bucket(bucket as any);

        const deleted = await objectStorageService.deleteByPrefix("record/");

        expect(deleted, "只算真正删过的那一轮").toBe(2);
        expect(bucket.listCalls.length).toBeLessThanOrEqual(3);
        expect(warnSpy, "必须留下「未推进」告警").toHaveBeenCalled();
    });

    it("大批量（10 页 × 1000）也不会一次性把 key 攒在内存里", async () => {
        const pages: ListPage[] = Array.from({ length: 10 }, (_, page) => ({
            keys: Array.from({ length: 1000 }, (_, i) => `record/${page * 1000 + i}`),
            truncated: page < 9,
        }));
        const bucket = new FakeBucket(pages);
        objectStorageService.setR2Bucket(bucket as any);

        const deleted = await objectStorageService.deleteByPrefix("record/");

        expect(deleted).toBe(10000);
        expect(bucket.deleteCalls).toHaveLength(10);
        expect(Math.max(...bucket.deleteCalls.map(keys => keys.length)), "每批不超过一页").toBe(1000);
    });
});
