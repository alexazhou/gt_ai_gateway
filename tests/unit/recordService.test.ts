import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import recordService from "../../src/service/recordService";
import { SgRecord } from "../../src/model/sgRecord";

// Mock SgRecord
vi.mock("../../src/model/sgRecord", () => ({
    SgRecord: {
        query: vi.fn(() => ({
            create: vi.fn((data) => Promise.resolve({ id: 1, ...data })),
            where: vi.fn(() => ({
                update: vi.fn((data) => Promise.resolve([1])),
            })),
            orderBy: vi.fn(() => ({
                limit: vi.fn(() => ({
                    get: vi.fn(() => Promise.resolve([])),
                })),
            })),
        })),
    },
}));

describe("recordService", () => {
    const originalEnv = process.env;
    const originalConsoleLog = console.log;

    beforeEach(() => {
        process.env = { ...originalEnv };
        console.log = vi.fn();
    });

    afterEach(() => {
        process.env = originalEnv;
        console.log = originalConsoleLog;
        vi.clearAllMocks();
    });

    it("should not log when RECORD_LOG_ENABLED is false", async () => {
        process.env.RECORD_LOG_ENABLED = "false";
        
        await recordService.create(1, 1, "test request");
        expect(console.log).not.toHaveBeenCalled();

        await recordService.update(1, { status: "success" as any });
        expect(console.log).not.toHaveBeenCalled();
    });

    it("should log when RECORD_LOG_ENABLED is true", async () => {
        process.env.RECORD_LOG_ENABLED = "true";
        
        await recordService.create(1, 1, "test request");
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining("[RecordService] Creating record: user=1, model=1"));
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining("test request"));

        await recordService.update(1, { status: "success" as any });
        expect(console.log).toHaveBeenCalledWith(
            expect.stringContaining("[RecordService] Updating record 1:"),
            expect.any(String)
        );
    });
});
