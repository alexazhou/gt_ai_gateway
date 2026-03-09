<template>
    <div class="dashboard">
        <!-- 统计卡片区域 -->
        <div class="stats-header">
            <h2 class="section-title">今日统计</h2>
            <a-space>
                <span v-if="lastUpdated" class="last-updated">
                    最后更新: {{ formatTime(lastUpdated) }}
                </span>
                <a-tooltip title="自动刷新">
                    <a-switch
                        v-model:checked="autoRefreshEnabled"
                        checked-children="开"
                        un-checked-children="关"
                        @change="handleAutoRefreshChange"
                    />
                </a-tooltip>
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
                    color="#1890ff"
                />
            </a-col>
            <a-col :span="6">
                <StatisticCard
                    title="请求成功率"
                    :value="(statsStore.stats?.success_rate || 0) * 100"
                    :precision="1"
                    suffix="%"
                    :loading="statsStore.loading"
                    :icon="CheckCircleOutlined"
                    color="#52c41a"
                />
            </a-col>
            <a-col :span="6">
                <StatisticCard
                    title="活跃用户"
                    :value="statsStore.stats?.active_users || 0"
                    :loading="statsStore.loading"
                    :icon="UserOutlined"
                    color="#722ed1"
                />
            </a-col>
            <a-col :span="6">
                <StatisticCard
                    title="活跃模型"
                    :value="statsStore.stats?.active_models || 0"
                    :loading="statsStore.loading"
                    :icon="RobotOutlined"
                    color="#eb2f96"
                />
            </a-col>
        </a-row>

        <!-- 原有系统统计 -->
        <a-row :gutter="[16, 16]" style="margin-top: 16px;">
            <a-col :span="5">
                <StatusCard
                    title="用户总数"
                    :value="systemStats.userCount"
                    :loading="loading"
                />
            </a-col>
            <a-col :span="5">
                <StatusCard
                    title="供应商总数"
                    :value="systemStats.vendorCount"
                    :loading="loading"
                />
            </a-col>
            <a-col :span="5">
                <StatusCard
                    title="模型总数"
                    :value="systemStats.modelCount"
                    :loading="loading"
                />
            </a-col>
            <a-col :span="5">
                <StatusCard
                    title="请求总数"
                    :value="systemStats.recordCount"
                    :loading="loading"
                />
            </a-col>
            <a-col :span="4">
                <StatusCard
                    title="系统状态"
                    :value="systemStatus"
                    description="后端服务运行状态"
                    :loading="loading"
                />
            </a-col>
        </a-row>

        <!-- 系统信息 -->
        <a-card title="系统信息" style="margin-top: 16px" :loading="loading">
            <a-descriptions :column="2" bordered>
                <a-descriptions-item label="环境">
                    {{ systemInfo.environment || '-' }}
                </a-descriptions-item>
                <a-descriptions-item label="版本">
                    {{ systemInfo.version || '-' }}
                </a-descriptions-item>
                <a-descriptions-item label="启动时间">
                    {{ systemInfo.startTime ? formatDate(systemInfo.startTime) : '-' }}
                </a-descriptions-item>
                <a-descriptions-item label="运行时间">
                    {{ systemInfo.uptime || '-' }}
                </a-descriptions-item>
            </a-descriptions>
        </a-card>

        <!-- 最近请求记录 -->
        <a-card
            title="最近请求"
            class="recent-records-card"
            :loading="statsStore.loading"
        >
            <a-table
                :columns="recentColumns"
                :data-source="statsStore.recentRecords"
                :pagination="false"
                size="small"
                :row-key="(record: any) => record.id"
            >
                <template #bodyCell="{ column, record }">
                    <template v-if="column.key === 'status'">
                        <a-tag :color="getStatusColor(record.status)">
                            {{ getStatusText(record.status) }}
                        </a-tag>
                    </template>
                    <template v-if="column.key === 'created_at'">
                        {{ formatDate(record.created_at) }}
                    </template>
                    <template v-if="column.key === 'action'">
                        <a-button type="link" size="small" @click="handleViewRecord(record.id)">
                            查看
                        </a-button>
                    </template>
                </template>
            </a-table>
            <div v-if="statsStore.recentRecords.length === 0" class="empty-records">
                暂无请求记录
            </div>
        </a-card>
    </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { useRouter } from 'vue-router';
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
import StatusCard from '@/components/common/StatusCard.vue';
import StatisticCard from '@/components/common/StatisticCard.vue';
const statsStore = useStatsStore();
const router = useRouter();

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

const autoRefreshEnabled = ref(false);

const lastUpdated = computed(() => statsStore.lastUpdated);

// 保存服务器启动时间
const serverStartTime = ref<Date | null>(null);
// 定时器引用
let uptimeTimer: number | null = null;

const recentColumns = [
    { title: 'ID', key: 'id', dataIndex: 'id', width: 60 },
    { title: '用户', key: 'user_name', dataIndex: 'user_name' },
    { title: '模型', key: 'model_name', dataIndex: 'model_name' },
    { title: '状态', key: 'status', dataIndex: 'status', width: 80 },
    { title: '时间', key: 'created_at', dataIndex: 'created_at', width: 150 },
    { title: '操作', key: 'action', width: 60 },
];

// 自动刷新
const { start: startAutoRefresh, stop: stopAutoRefresh } = useAutoRefresh({
    callback: () => {
        refreshAll();
    },
    defaultInterval: 30000,
    immediate: false,
});

onMounted(() => {
    loadSystemData();
    refreshAll();
});

onUnmounted(() => {
    stopAutoRefresh();
    if (uptimeTimer) {
        clearInterval(uptimeTimer);
        uptimeTimer = null;
    }
});

async function refreshAll() {
    await Promise.all([
        statsStore.refreshAll(),
    ]);
}

function handleRefresh() {
    refreshAll();
    loadSystemData();
}

function handleAutoRefreshChange(checked: boolean) {
    if (checked) {
        startAutoRefresh();
    } else {
        stopAutoRefresh();
    }
}

async function loadSystemData() {
    loading.value = true;
    try {
        const [users, vendors, models, systemStatusData] = await Promise.all([
            listUsers(),
            listVendors(),
            listModels(),
            status().catch(() => null),
        ]);

        systemStats.value = {
            userCount: users.length,
            vendorCount: vendors.length,
            modelCount: models.length,
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

function handleViewRecord(id: number) {
    router.push(`/record/${id}`);
}

function getStatusColor(status: string): string {
    switch (status) {
        case 'success':
            return 'success';
        case 'failed':
            return 'error';
        case 'processing':
            return 'processing';
        case 'init':
        default:
            return 'default';
    }
}

function getStatusText(status: string): string {
    switch (status) {
        case 'success':
            return '成功';
        case 'failed':
            return '失败';
        case 'processing':
            return '处理中';
        case 'init':
            return '初始化';
        default:
            return '未知';
    }
}

function formatTime(date: Date): string {
    return date.toLocaleTimeString();
}
</script>

<style scoped>
.dashboard {
    background: #fff;
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
}

.last-updated {
    font-size: 12px;
    color: #8c8c8c;
}

.recent-records-card {
    margin-top: 16px;
}

.empty-records {
    text-align: center;
    padding: 40px;
    color: #8c8c8c;
}

.dashboard :deep(.ant-descriptions-item-label) {
    width: 120px;
    min-width: 120px;
}

.dashboard :deep(.ant-descriptions-item-content) {
    min-width: 150px;
}
</style>
