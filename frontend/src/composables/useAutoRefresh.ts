import { computed, onUnmounted, ref } from 'vue';
import type { ComputedRef } from 'vue';

type RefreshCallback = () => void | Promise<void>;

interface UseAutoRefreshOptions {
    callback: RefreshCallback;
    defaultInterval?: number;
    immediate?: boolean;
}

interface UseAutoReturn {
    isRunning: ReturnType<typeof ref<boolean>>;
    isRefreshing: ReturnType<typeof ref<boolean>>;
    interval: ReturnType<typeof ref<number>>;
    remainingSeconds: ComputedRef<number>;
    start: () => Promise<void>;
    stop: () => void;
    restart: () => Promise<void>;
    setIntervalValue: (value: number) => void;
}

export function useAutoRefresh(options: UseAutoRefreshOptions): UseAutoReturn {
    const { callback, defaultInterval = 30000, immediate = false } = options;

    const isRunning = ref(false);
    const isRefreshing = ref(false);
    const interval = ref(defaultInterval);
    const remainingMs = ref(defaultInterval);
    const remainingSeconds = computed(() => Math.max(0, Math.ceil(remainingMs.value / 1000)));
    let refreshTimer: number | null = null;
    let countdownTimer: number | null = null;

    function clearTimers(): void {
        if (refreshTimer) {
            clearTimeout(refreshTimer);
            refreshTimer = null;
        }

        if (countdownTimer) {
            clearInterval(countdownTimer);
            countdownTimer = null;
        }
    }

    function startCountdown(): void {
        const endAt = Date.now() + interval.value;
        remainingMs.value = interval.value;

        countdownTimer = window.setInterval(() => {
            const nextRemainingMs = Math.max(0, endAt - Date.now());
            remainingMs.value = nextRemainingMs;

            if (nextRemainingMs === 0 && countdownTimer) {
                clearInterval(countdownTimer);
                countdownTimer = null;
            }
        }, 1000);
    }

    async function runRefresh(): Promise<void> {
        if (isRefreshing.value) {
            return;
        }

        isRefreshing.value = true;
        try {
            await callback();
        } finally {
            isRefreshing.value = false;
        }
    }

    function scheduleNextRefresh(): void {
        clearTimers();
        startCountdown();

        refreshTimer = window.setTimeout(async () => {
            await runRefresh();

            if (isRunning.value) {
                scheduleNextRefresh();
            }
        }, interval.value);
    }

    async function start(): Promise<void> {
        if (isRunning.value) return;

        isRunning.value = true;

        // 立即执行一次
        await runRefresh();

        if (!isRunning.value) {
            return;
        }

        scheduleNextRefresh();
    }

    function stop(): void {
        clearTimers();
        remainingMs.value = interval.value;
        isRunning.value = false;
    }

    async function restart(): Promise<void> {
        stop();
        await start();
    }

    function setIntervalValue(value: number): void {
        interval.value = value;
        if (isRunning.value) {
            void restart();
        }
    }

    // 组件卸载时清理
    onUnmounted(() => {
        stop();
    });

    // 如果设置了立即执行，则启动
    if (immediate) {
        void start();
    }

    return {
        isRunning,
        isRefreshing,
        interval,
        remainingSeconds,
        start,
        stop,
        restart,
        setIntervalValue,
    };
}
