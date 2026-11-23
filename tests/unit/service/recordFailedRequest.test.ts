import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P2-11：失败记录写不进去不能「静默丢账」。
 *
 * 场景：用户被规则拒绝 / 上游失败，本来要落一条 FAILED 记录 + 活动日志；
 * 如果写库失败（D1 抖动、SQLITE_BUSY、并发写锁），原实现直接吞掉异常，
 * 结果「用户被拒但系统里查不到任何痕迹」，排障时完全断线。
 *
 * 现在的约定：写失败重试一次；仍失败则输出结构化 `[RECORD_WRITE_FAILED]` 日志
 * （含 userId/modelId/failedCode/bodyBytes/两次错误摘要），且**绝不把异常抛给调用方**
 * （失败记账不能反过来把请求打成 500），**也不把请求体/凭据写进日志**。
 */

const createMock = vi.fn();
const updateMock = vi.fn();
const activityAppendMock = vi.fn();
// markFailed 在写活动前会做一次「record 还可能存在吗」的守卫（#332），
// 本文件只关心「写不写活动」，所以守卫恒真，避免把存在性读也拖进这组用例。
const recordStillExistsMock = vi.fn();

vi.mock("../../../src/manager/recordManager", () => ({
    default: {
        create: (...args: unknown[]) => createMock(...args),
        update: (...args: unknown[]) => updateMock(...args),
    },
}));

vi.mock("../../../src/service/configService", () => ({
    default: {
        getConfig: () => ({ getBoolean: () => false }),
    },
}));

vi.mock("../../../src/service/requestActivityService", () => ({
    default: {
        append: (...args: unknown[]) => activityAppendMock(...args),
        recordStillExists: (...args: unknown[]) => recordStillExistsMock(...args),
    },
}));

vi.mock("../../../src/service/objectStorageService", () => ({
    default: {
        getText: async () => null,
        putText: async () => undefined,
        delete: async () => undefined,
    },
}));

const { default: recordService } = await import("../../../src/service/recordService");

const FAILED_CODE = "rule_denied";
const SECRET_BODY = JSON.stringify({ model: "gpt-x", messages: [{ role: "user", content: "sk-super-secret-token" }] });

function makeRecord(id = 1) {
    return { id, created_at: new Date() };
}

describe("recordFailedRequest 重试与结构化日志（P2-11）", () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        createMock.mockReset();
        updateMock.mockReset();
        activityAppendMock.mockReset();
        recordStillExistsMock.mockReset();
        recordStillExistsMock.mockResolvedValue(true);
        updateMock.mockResolvedValue(makeRecord());
        activityAppendMock.mockResolvedValue(undefined);
        errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        errorSpy.mockRestore();
    });

    const call = () => recordService.recordFailedRequest(
        42,
        "gpt-x",
        SECRET_BODY,
        "openai" as any,
        FAILED_CODE,
        7,
        "规则拒绝",
        { ruleId: 3 },
        1,
    );

    it("首次就成功：只写一次，不打失败日志", async () => {
        createMock.mockResolvedValueOnce(makeRecord());

        await call();

        expect(createMock).toHaveBeenCalledTimes(1);
        expect(updateMock, "要把它标成 FAILED").toHaveBeenCalledTimes(1);
        expect(activityAppendMock, "失败时间线要留一条活动").toHaveBeenCalledTimes(1);
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it("首次失败、重试成功：共写两次，仍然不打失败日志", async () => {
        createMock
            .mockRejectedValueOnce(new Error("SQLITE_BUSY"))
            .mockResolvedValueOnce(makeRecord());

        await expect(call()).resolves.toBeUndefined();

        expect(createMock, "失败必须重试一次").toHaveBeenCalledTimes(2);
        expect(updateMock).toHaveBeenCalledTimes(1);
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it("两次都失败：输出 [RECORD_WRITE_FAILED] 结构化日志，且不向调用方抛错", async () => {
        createMock
            .mockRejectedValueOnce(new Error("SQLITE_BUSY"))
            .mockRejectedValueOnce(new Error("database is locked"));

        await expect(call(), "失败记账不能反过来把请求打成 500").resolves.toBeUndefined();

        expect(createMock).toHaveBeenCalledTimes(2);
        expect(errorSpy, "必须留一条可检索的日志").toHaveBeenCalledTimes(1);

        const [tag, payload] = errorSpy.mock.calls[0] as [string, string];
        expect(tag).toBe("[RECORD_WRITE_FAILED]");

        const parsed = JSON.parse(payload);
        expect(parsed.userId).toBe(42);
        expect(parsed.modelId).toBe(7);
        expect(parsed.failedCode).toBe(FAILED_CODE);
        expect(parsed.bodyBytes, "只记长度，不记内容").toBe(SECRET_BODY.length);
        expect(parsed.firstError).toContain("SQLITE_BUSY");
        expect(parsed.retryError).toContain("database is locked");
        expect(parsed.detail).toEqual({ ruleId: 3 });
    });

    it("日志里不得出现请求体内容/凭据", async () => {
        createMock
            .mockRejectedValueOnce(new Error("write failed"))
            .mockRejectedValueOnce(new Error("write failed again"));

        await call();

        const payload = (errorSpy.mock.calls[0] as [string, string])[1];
        expect(payload).not.toContain("sk-super-secret-token");
        expect(payload).not.toContain("sk-");
        expect(payload, "只允许出现长度字段").not.toContain(SECRET_BODY);
    });

    it("重试成功后不再重复写活动日志（只留一条时间线）", async () => {
        createMock
            .mockRejectedValueOnce(new Error("transient"))
            .mockResolvedValueOnce(makeRecord());

        await call();

        expect(activityAppendMock).toHaveBeenCalledTimes(1);
        expect(updateMock.mock.calls[0][1]).toMatchObject({ failed_code: FAILED_CODE });
    });

    // ---- #332：失败收尾也可能在 record 被删除之后才 fire（waitUntil 迟到 ≈185s）----

    it("#332 守卫：record 已删时 markFailed 不写活动行（不产生孤儿活动）", async () => {
        createMock.mockResolvedValueOnce(makeRecord());
        recordStillExistsMock.mockResolvedValue(false);

        await call();

        expect(updateMock, "record 收尾照旧执行（UPDATE 命中 0 行即无副作用）").toHaveBeenCalledTimes(1);
        expect(activityAppendMock, "record 已删 ⇒ 活动行不能写，否则就是清不掉的孤儿").not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
    });

    it("#332 守卫：存在性检查抛错时不写活动行（异常由上层兜底，不外泄成 500）", async () => {
        createMock.mockResolvedValueOnce(makeRecord());
        recordStillExistsMock.mockRejectedValue(new Error("D1 unavailable"));

        // 异常会从 markFailed 抛给 recordFailedRequest，由它兜底（本文件既有契约：
        // 失败记账不能反过来把请求打成 500）；关键判据是「没写活动行」。
        await expect(call()).resolves.toBeUndefined();
        expect(activityAppendMock).not.toHaveBeenCalled();
    });
});
