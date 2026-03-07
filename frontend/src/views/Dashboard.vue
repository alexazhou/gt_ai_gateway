<template>
    <div class="dashboard">
        <a-row :gutter="[16, 16]">
            <a-col :span="5">
                <StatusCard
                    title="用户总数"
                    :value="stats.userCount"
                    :loading="loading"
                />
            </a-col>
            <a-col :span="5">
                <StatusCard
                    title="供应商总数"
                    :value="stats.vendorCount"
                    :loading="loading"
                />
            </a-col>
            <a-col :span="5">
                <StatusCard
                    title="模型总数"
                    :value="stats.modelCount"
                    :loading="loading"
                />
            </a-col>
            <a-col :span="5">
                <StatusCard
                    title="请求总数"
                    :value="stats.recordCount"
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
    </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { listUsers } from '@/api/user';
import { listVendors } from '@/api/vendor';
import { listModels } from '@/api/model';
import { status } from '@/api/system';
import { formatDate } from '@/utils/format';
import StatusCard from '@/components/common/StatusCard.vue';

const loading = ref(false);
const stats = ref({
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

// 保存服务器启动时间
const serverStartTime = ref<Date | null>(null);
// 定时器引用
let uptimeTimer: number | null = null;

/**
 * 计算运行时长
 */
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

/**
 * 更新运行时间
 */
function updateUptime() {
    if (serverStartTime.value) {
        systemInfo.value.uptime = formatUptime(serverStartTime.value);
    }
}

onMounted(() => {
    loadData();
});

onUnmounted(() => {
    if (uptimeTimer) {
        clearInterval(uptimeTimer);
        uptimeTimer = null;
    }
});

async function loadData() {
    loading.value = true;
    try {
        const [users, vendors, models, systemStatusData] = await Promise.all([
            listUsers(),
            listVendors(),
            listModels(),
            status().catch(() => null),
        ]);

        stats.value = {
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

            // 启动定时更新运行时间（每秒更新一次）
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
</script>

<style scoped>
.dashboard {
    background: #fff;
    padding: 24px;
}

.dashboard :deep(.ant-descriptions-item-label) {
    width: 120px;
    min-width: 120px;
}

.dashboard :deep(.ant-descriptions-item-content) {
    min-width: 150px;
}
</style>
