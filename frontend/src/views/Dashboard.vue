<template>
    <div class="dashboard">
        <a-row :gutter="[16, 16]">
            <a-col :span="6">
                <StatusCard
                    title="用户总数"
                    :value="stats.userCount"
                    :loading="loading"
                />
            </a-col>
            <a-col :span="6">
                <StatusCard
                    title="供应商总数"
                    :value="stats.vendorCount"
                    :loading="loading"
                />
            </a-col>
            <a-col :span="6">
                <StatusCard
                    title="模型总数"
                    :value="stats.modelCount"
                    :loading="loading"
                />
            </a-col>
            <a-col :span="6">
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
import { ref, onMounted } from 'vue';
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
});

const systemStatus = ref('正常');
const systemInfo = ref({
    environment: '',
    version: '',
    startTime: '',
    uptime: '',
});

onMounted(() => {
    loadData();
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
        };

        if (systemStatusData) {
            systemInfo.value = {
                environment: systemStatusData.environment || '',
                version: systemStatusData.version || '',
                startTime: systemStatusData.startTime || '',
                uptime: systemStatusData.uptime || '',
            };
            systemStatus.value = '正常';
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
</style>
