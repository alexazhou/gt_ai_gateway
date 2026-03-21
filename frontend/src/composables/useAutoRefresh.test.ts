import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutoRefresh } from './useAutoRefresh';

function flushPromises(): Promise<void> {
    return new Promise((resolve) => {
        queueMicrotask(() => resolve());
    });
}

describe('useAutoRefresh', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('runs the initial refresh before scheduling the next cycle', async () => {
        const callback = vi.fn().mockResolvedValue(undefined);
        const autoRefresh = useAutoRefresh({
            callback,
            defaultInterval: 1000,
        });

        const startPromise = autoRefresh.start();

        expect(callback).toHaveBeenCalledTimes(1);
        expect(autoRefresh.isRefreshing.value).toBe(true);

        await startPromise;

        expect(autoRefresh.isRunning.value).toBe(true);
        expect(autoRefresh.isRefreshing.value).toBe(false);

        vi.advanceTimersByTime(1000);
        await flushPromises();

        expect(callback).toHaveBeenCalledTimes(2);
    });

    it('does not overlap refresh executions', async () => {
        let resolveRefresh: () => void = () => undefined;
        const callback = vi.fn().mockImplementation(() => {
            return new Promise<void>((resolve) => {
                resolveRefresh = resolve;
            });
        });

        const autoRefresh = useAutoRefresh({
            callback,
            defaultInterval: 1000,
        });

        const startPromise = autoRefresh.start();

        expect(callback).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(5000);
        await flushPromises();
        expect(callback).toHaveBeenCalledTimes(1);

        resolveRefresh();
        await startPromise;

        vi.advanceTimersByTime(1000);
        await flushPromises();

        expect(callback).toHaveBeenCalledTimes(2);
    });
});
