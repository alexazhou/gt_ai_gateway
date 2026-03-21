<template>
    <div class="dashboard">
        <!-- 统计卡片区域 -->
        <div class="stats-header">
            <h2 class="section-title">今日统计</h2>
            <a-space class="stats-toolbar" :size="10">
                <span v-if="lastUpdated" class="last-updated">
                    最后更新: {{ formatTime(lastUpdated) }}
                </span>
                <a-tooltip title="自动刷新">
                    <a-switch
                        class="toolbar-switch"
                        v-model:checked="autoRefreshEnabled"
                        checked-children="开"
                        un-checked-children="关"
                        @change="handleAutoRefreshChange"
                    />
                </a-tooltip>
                <span class="last-updated">
                    自动刷新
                    <template v-if="autoRefreshEnabled">
                        ({{ remainingSeconds }} 秒后刷新)
                    </template>
                </span>
                <a-button
                    type="primary"
                    size="small"
                    :loading="statsStore.loading"
                    @click="handleRefresh"
                >
                    刷新
                </a-button>
            </a-space>
        </div>

        <a-row :gutter="[16, 16]">
            <a-col :span="6">
                <StatisticCard
                    title="今日请求数"
                    :value="statsStore.stats?.today_requests || 0"
                    :loading="statsStore.loading"
                    :icon="BarChartOutlined"
                    color="var(--accent-primary)"
                />
            </a-col>
            <a-col :span="6">
                <StatisticCard
                    title="今日请求成功率"
                    :value="statsStore.stats?.success_rate !== null && statsStore.stats?.success_rate !== undefined
                        ? statsStore.stats.success_rate * 100
                        : null"
                    :precision="1"
                    suffix="%"
                    :loading="statsStore.loading"
                    :icon="CheckCircleOutlined"
                    color="#52c41a"
                />
            </a-col>
            <a-col :span="6">
                <StatisticCard
                    title="今日活跃用户"
                    :value="statsStore.stats?.active_users || 0"
                    :loading="statsStore.loading"
                    :icon="UserOutlined"
                    color="var(--accent-primary)"
                />
            </a-col>
            <a-col :span="6">
                <StatisticCard
                    title="今日活跃模型"
                    :value="statsStore.stats?.active_models || 0"
                    :loading="statsStore.loading"
                    :icon="RobotOutlined"
                    color="var(--accent-primary)"
                />
            </a-col>
        </a-row>

        <!-- 原有系统统计 -->
        <div class="status-grid">
            <div class="status-grid-item">
                <StatusCard
                    title="用户总数"
                    :value="systemStats.userCount"
                    :loading="loading"
                />
            </div>
            <div class="status-grid-item">
                <StatusCard
                    title="供应商总数"
                    :value="systemStats.vendorCount"
                    :loading="loading"
                />
            </div>
            <div class="status-grid-item">
                <StatusCard
                    title="模型总数"
                    :value="systemStats.modelCount"
                    :loading="loading"
                />
            </div>
            <div class="status-grid-item">
                <StatusCard
                    title="请求总数"
                    :value="systemStats.recordCount"
                    :loading="loading"
                />
            </div>
            <div class="status-grid-item">
                <StatusCard
                    title="系统状态"
                    :value="systemStatus"
                    :loading="loading"
                />
            </div>
        </div>

        <!-- 系统信息 -->
        <a-card title="系统信息" style="margin-top: 16px" :loading="loading">
            <div class="system-info-grid">
                <div class="system-info-item">
                    <span class="system-info-label">环境</span>
                    <span class="system-info-value">
                        {{ systemInfo.environment || '-' }}
                    </span>
                </div>
                <div class="system-info-item">
                    <span class="system-info-label">版本</span>
                    <span class="system-info-value">
                        {{ systemInfo.version || '-' }}
                    </span>
                </div>
                <div class="system-info-item">
                    <span class="system-info-label">启动时间</span>
                    <span class="system-info-value">
                        {{ systemInfo.startTime ? formatDate(systemInfo.startTime) : '-' }}
                    </span>
                </div>
                <div class="system-info-item">
                    <span class="system-info-label">运行时间</span>
                    <span class="system-info-value">
                        {{ systemInfo.uptime || '-' }}
                    </span>
                </div>
            </div>
        </a-card>

        <!-- 最近请求记录 -->
        <a-card
            title="最近请求"
            class="recent-records-card"
            :loading="statsStore.loading"
        >
            <RecordTable
                :records="statsStore.recentRecords"
                size="small"
                :columns="recentColumns"
            />
            <div v-if="statsStore.recentRecords.length === 0" class="empty-records">
                暂无请求记录
            </div>
        </a-card>
    </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import {
    BarChartOutlined,
    CheckCircleOutlined,
    UserOutlined,
    RobotOutlined,
} from '@ant-design/icons-vue';
import { listUsers } from '@/api/user';
import { listVendors } from '@/api/vendor';
import { listModels } from '@/api/model';
import { status } from '@/api/system';
import { useStatsStore } from '@/stores/stats';
import { useAutoRefresh } from '@/composables/useAutoRefresh';
import { formatDate } from '@/utils/format';
import { normalizeListResponse } from '@/utils/listResponse';
import StatusCard from '@/components/common/StatusCard.vue';
import StatisticCard from '@/components/common/StatisticCard.vue';
import RecordTable from '@/components/common/RecordTable.vue';

const statsStore = useStatsStore();

const loading = ref(false);
const systemStats = ref({
    userCount: 0,
    vendorCount: 0,
    modelCount: 0,
    recordCount: 0,
});

const systemStatus = ref('正常');
const systemInfo = ref({
    environment: '',
    version: '',
    startTime: '',
    uptime: '',
});

const lastUpdated = computed(() => statsStore.lastUpdated);

// 保存服务器启动时间
const serverStartTime = ref<Date | null>(null);
// 定时器引用
let uptimeTimer: number | null = null;

const recentColumns = [
    { title: 'ID', key: 'id', dataIndex: 'id', width: 60 },
    { title: '用户', key: 'user_name', dataIndex: 'user_name' },
    { title: '供应商', key: 'vendor_name', dataIndex: 'vendor_name' },
    { title: '模型', key: 'model_name', dataIndex: 'model_name' },
    { title: '状态', key: 'status', dataIndex: 'status', width: 80 },
    { title: '时间', key: 'created_at', dataIndex: 'created_at', width: 150 },
    { title: '操作', key: 'action', width: 60 },
];

// 自动刷新
const {
    isRunning: autoRefreshEnabled,
    start: startAutoRefresh,
    stop: stopAutoRefresh,
    remainingSeconds,
} = useAutoRefresh({
    callback: () => {
        return loadDashboardData();
    },
    defaultInterval: 30000,
    immediate: false,
});

onMounted(() => {
    void loadDashboardData();
});

onUnmounted(() => {
    stopAutoRefresh();
    if (uptimeTimer) {
        clearInterval(uptimeTimer);
        uptimeTimer = null;
    }
});

async function loadDashboardData(): Promise<void> {
    await Promise.all([
        statsStore.refreshAll(),
        loadSystemData(),
    ]);
}

function handleRefresh(): void {
    void loadDashboardData();
}

function handleAutoRefreshChange(checked: boolean): void {
    if (checked) {
        void startAutoRefresh();
    } else {
        stopAutoRefresh();
    }
}

async function loadSystemData() {
    loading.value = true;
    try {
        const [users, vendors, models, systemStatusData] = await Promise.all([
            listUsers({ page: 1, pageSize: 1 }),
            listVendors({ page: 1, pageSize: 1 }),
            listModels({ page: 1, pageSize: 1 }),
            status().catch(() => null),
        ]);

        const normalizedUsers = normalizeListResponse(users);
        const normalizedVendors = normalizeListResponse(vendors);
        const normalizedModels = normalizeListResponse(models);

        systemStats.value = {
            userCount: normalizedUsers.total,
            vendorCount: normalizedVendors.total,
            modelCount: normalizedModels.total,
            recordCount: systemStatusData?.statistics?.records || 0,
        };

        if (systemStatusData) {
            const startTimeStr = systemStatusData.system?.startTime || '';
            if (startTimeStr) {
                serverStartTime.value = new Date(startTimeStr);
            }

            systemInfo.value = {
                environment: systemStatusData.system?.environment || '',
                version: systemStatusData.system?.version || '',
                startTime: startTimeStr,
                uptime: serverStartTime.value ? formatUptime(serverStartTime.value) : '',
            };
            systemStatus.value = '正常';

            // 启动定时更新运行时间
            if (uptimeTimer) {
                clearInterval(uptimeTimer);
            }
            uptimeTimer = setInterval(updateUptime, 1000);
        } else {
            systemStatus.value = '异常';
        }
    } catch (error) {
        console.error('加载数据失败:', error);
        systemStatus.value = '异常';
    } finally {
        loading.value = false;
    }
}

function formatUptime(startTime: Date): string {
    const now = new Date();
    const diff = now.getTime() - startTime.getTime();
    const totalSeconds = Math.floor(diff / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}天`);
    if (hours > 0) parts.push(`${hours}小时`);
    if (minutes > 0) parts.push(`${minutes}分钟`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}秒`);

    return parts.join(' ');
}

function updateUptime() {
    if (serverStartTime.value) {
        systemInfo.value.uptime = formatUptime(serverStartTime.value);
    }
}

function formatTime(date: Date): string {
    return date.toLocaleTimeString();
}
</script>

<style scoped>
.dashboard {
    background: var(--bg-page);
    padding: 24px;
}

.stats-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
}

.section-title {
    font-size: 18px;
    font-weight: 500;
    margin: 0;
    color: var(--text-primary);
}

.last-updated {
    font-size: 12px;
    color: var(--text-secondary);
}

.stats-toolbar {
    display: inline-flex;
    align-items: center;
}

.stats-toolbar :deep(.ant-space-item) {
    display: flex;
    align-items: center;
}

.stats-toolbar :deep(.ant-switch) {
    background: var(--toolbar-switch-off);
}

.stats-toolbar :deep(.ant-switch .ant-switch-handle::before) {
    background: var(--toolbar-switch-handle);
}

.stats-toolbar :deep(.ant-switch.ant-switch-checked) {
    background: var(--accent-primary);
}

.recent-records-card {
    margin-top: 16px;
}

.status-grid {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 16px;
    margin-top: 16px;
}

.status-grid-item {
    min-width: 0;
}

.empty-records {
    text-align: center;
    padding: 40px;
    color: var(--text-secondary);
}

.system-info-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px 16px;
}

.system-info-item {
    display: flex;
    align-items: center;
    min-height: 64px;
    padding: 0 20px;
    border: 1px solid var(--border-info-item);
    border-radius: 12px;
    background: var(--bg-info-item);
}

.system-info-label {
    flex: 0 0 96px;
    color: var(--text-secondary);
    font-size: 13px;
}

.system-info-value {
    color: var(--text-primary);
    font-weight: 500;
}

@media (max-width: 768px) {
    .status-grid {
        grid-template-columns: 1fr;
    }

    .system-info-grid {
        grid-template-columns: 1fr;
    }
}
</style>
