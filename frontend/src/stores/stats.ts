import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { getDashboardStats, getRecentRecords } from '@/api/stats';
import { useRecordStore } from './record';
import type { DashboardStats, RecentRecord } from '@/types/stats';

const STATS_CACHE_DURATION = 60000; // 60秒缓存

export const useStatsStore = defineStore('stats', () => {
    // State
    const stats = ref<DashboardStats | null>(null);
    const recentRecords = ref<RecentRecord[]>([]);
    const loading = ref(false);
    const lastUpdated = ref<Date | null>(null);

    // Getters
    const isStatsValid = computed(() => {
        if (!lastUpdated.value) return false;
        const now = new Date().getTime();
        const last = lastUpdated.value.getTime();
        return now - last < STATS_CACHE_DURATION;
    });

    const successRateFormatted = computed(() => {
        if (!stats.value) return '0%';
        return `${(stats.value.success_rate * 100).toFixed(1)}%`;
    });

    // Actions
    async function fetchStats(force: boolean = false): Promise<void> {
        if (!force && isStatsValid.value) return;

        loading.value = true;
        try {
            const response = await getDashboardStats();
            stats.value = response;
            lastUpdated.value = new Date();
        } catch (error) {
            console.error('获取统计数据失败:', error);
        } finally {
            loading.value = false;
        }
    }

    async function fetchRecent(limit: number = 10): Promise<void> {
        try {
            const recordStore = useRecordStore();
            const response = await getRecentRecords(limit);
            const records = response || [];
            
            if (records.length > 0) {
                await recordStore.enrichRecords(records);
            }
            
            recentRecords.value = records;
        } catch (error) {
            console.error('获取最近记录失败:', error);
            recentRecords.value = [];
        }
    }

    async function refreshAll(): Promise<void> {
        await Promise.all([
            fetchStats(true),
            fetchRecent(),
        ]);
    }

    return {
        stats,
        recentRecords,
        loading,
        lastUpdated,
        isStatsValid,
        successRateFormatted,
        fetchStats,
        fetchRecent,
        refreshAll,
    };
});
