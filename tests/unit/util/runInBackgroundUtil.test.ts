import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runInBackground } from "../../../src/util/runInBackgroundUtil";
import { Context } from "hono";

describe("runInBackgroundUtil", () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
    });

    it("should use executionCtx.waitUntil if available", async () => {
        const waitUntilMock = vi.fn();
        const mockContext = {
            executionCtx: {
                waitUntil: waitUntilMock,
            },
        } as unknown as Context;

        const taskPromise = Promise.resolve();
        const mockTask = vi.fn().mockReturnValue(taskPromise);

        runInBackground(mockContext, mockTask);

        expect(mockTask).toHaveBeenCalledTimes(1);
        expect(waitUntilMock).toHaveBeenCalledTimes(1);
        expect(waitUntilMock).toHaveBeenCalledWith(taskPromise);
    });

    it("should fallback to unhandled execution if executionCtx is not available", async () => {
        const mockContext = {} as Context;

        const taskPromise = Promise.resolve();
        const mockTask = vi.fn().mockReturnValue(taskPromise);

        runInBackground(mockContext, mockTask);

        expect(mockTask).toHaveBeenCalledTimes(1);
        
        // Wait a microtask to ensure background execution completes
        await Promise.resolve();
        expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("should gracefully handle environments where executionCtx getter throws an error", async () => {
        // Simulate Node.js Hono adapter behavior where accessing executionCtx throws
        const mockContext = Object.defineProperty({}, "executionCtx", {
            get() {
                throw new Error("This context has no ExecutionContext");
            }
        }) as Context;

        const taskPromise = Promise.resolve();
        const mockTask = vi.fn().mockReturnValue(taskPromise);

        // This should not throw, it should swallow the getter error and fallback
        expect(() => runInBackground(mockContext, mockTask)).not.toThrow();
        expect(mockTask).toHaveBeenCalledTimes(1);
    });

    it("should log error if task fails and no waitUntil is available", async () => {
        const mockContext = {} as Context;
        const error = new Error("Task failed");
        
        // Task returns a rejected promise
        const mockTask = vi.fn().mockRejectedValue(error);

        runInBackground(mockContext, mockTask);

        // Wait a microtask to ensure the catch block executes
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(consoleErrorSpy).toHaveBeenCalledWith("[runInBackground] Error in background task:", error);
    });
});
