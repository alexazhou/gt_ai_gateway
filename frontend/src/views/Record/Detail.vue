<template>
    <div class="record-detail">
        <a-page-header
            title="请求记录详情"
            @back="handleBack"
        />

        <a-spin :spinning="recordStore.loading">
            <div v-if="recordStore.currentRecord" class="detail-content">
                <!-- 基本信息 -->
                <a-card title="基本信息" class="detail-card">
                    <a-descriptions :column="2" bordered>
                        <a-descriptions-item label="请求 ID">
                            {{ recordStore.currentRecord.id }}
                        </a-descriptions-item>
                        <a-descriptions-item label="状态">
                            <a-tag :color="getStatusColor(recordStore.currentRecord.status)">
                                {{ getStatusText(recordStore.currentRecord.status) }}
                            </a-tag>
                        </a-descriptions-item>
                        <a-descriptions-item label="用户">
                            {{ recordStore.currentRecord.user_name || '-' }}
                        </a-descriptions-item>
                        <a-descriptions-item label="模型">
                            {{ recordStore.currentRecord.model_name || '-' }}
                        </a-descriptions-item>
                        <a-descriptions-item label="供应商">
                            {{ recordStore.currentRecord.vendor_name || '-' }}
                        </a-descriptions-item>
                        <a-descriptions-item label="创建时间">
                            {{ formatDate(recordStore.currentRecord.created_at) }}
                        </a-descriptions-item>
                        <a-descriptions-item label="提示词 Token" v-if="recordStore.currentRecord.prompt_tokens">
                            <span class="token-item">
                                <ArrowUpOutlined class="token-icon input" />
                                {{ recordStore.currentRecord.prompt_tokens }}
                            </span>
                        </a-descriptions-item>
                        <a-descriptions-item label="输出 Token" v-if="recordStore.currentRecord.output_tokens">
                            <span class="token-item">
                                <ArrowDownOutlined class="token-icon output" />
                                {{ recordStore.currentRecord.output_tokens }}
                            </span>
                        </a-descriptions-item>
                        <a-descriptions-item label="首 Token 延迟" v-if="recordStore.currentRecord.first_token_latency">
                            {{ recordStore.currentRecord.first_token_latency }}ms
                        </a-descriptions-item>
                    </a-descriptions>
                </a-card>

                <!-- 请求数据 -->
                <a-card title="请求数据" class="detail-card">
                    <template #extra>
                        <a-button
                            type="link"
                            size="small"
                            :disabled="!recordStore.currentRecord?.request_data"
                            @click="downloadJson(recordStore.currentRecord?.request_data, 'request')"
                        >
                            <template #icon><DownloadOutlined /></template>
                            下载
                        </a-button>
                    </template>
                    <JsonViewer :data="recordStore.currentRecord.request_data" />
                </a-card>

                <!-- 响应数据 -->
                <a-card title="响应数据" class="detail-card">
                    <template #extra>
                        <a-button
                            type="link"
                            size="small"
                            :disabled="!recordStore.currentRecord?.response_data"
                            @click="downloadJson(recordStore.currentRecord?.response_data, 'response')"
                        >
                            <template #icon><DownloadOutlined /></template>
                            下载
                        </a-button>
                    </template>
                    <JsonViewer :data="recordStore.currentRecord.response_data" />
                </a-card>

                <!-- 错误信息 -->
                <a-card
                    v-if="recordStore.currentRecord.status === 'failed'"
                    title="错误信息"
                    class="detail-card error-card"
                >
                    <a-alert
                        type="error"
                        :message="getErrorMessage(recordStore.currentRecord.response_data)"
                        show-icon
                    />
                </a-card>
            </div>

            <a-empty v-else description="记录不存在" />
        </a-spin>
    </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { DownloadOutlined, ArrowUpOutlined, ArrowDownOutlined } from '@ant-design/icons-vue';
import { useRecordStore } from '@/stores/record';
import { formatDate } from '@/utils/format';
import JsonViewer from '@/components/common/JsonViewer.vue';
import { message } from 'ant-design-vue/es';

const router = useRouter();
const route = useRoute();
const recordStore = useRecordStore();

onMounted(() => {
    const id = parseInt(route.params.id as string, 10);
    if (!isNaN(id)) {
        recordStore.fetchRecordDetail(id);
    }
});

onUnmounted(() => {
    recordStore.clearCurrentRecord();
});

function handleBack() {
    router.back();
}

function getStatusColor(status: string | null): string {
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

function getStatusText(status: string | null): string {
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

function getErrorMessage(responseData: string | null): string {
    if (!responseData) return '未知错误';
    try {
        const parsed = JSON.parse(responseData);
        return parsed.error?.message || parsed.error || '请求失败';
    } catch {
        return responseData || '请求失败';
    }
}


function downloadJson(data: string | null, type: 'request' | 'response') {
    if (!data) {
        message.warning('没有数据可下载');
        return;
    }

    try {
        // 格式化 JSON
        const parsed = JSON.parse(data);
        const formatted = JSON.stringify(parsed, null, 2);

        // 创建 Blob
        const blob = new Blob([formatted], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        // 创建下载链接
        const link = document.createElement('a');
        const recordId = recordStore.currentRecord?.id || 'unknown';
        const timestamp = formatDate(new Date()).replace(/[:\s]/g, '-');
        link.href = url;
        link.download = `record-${recordId}-${type}-${timestamp}.json`;

        // 触发下载
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        // 释放 URL
        URL.revokeObjectURL(url);

        message.success('下载成功');
    } catch (_error) {
        message.error('下载失败：数据格式错误');
    }
}
</script>

<style scoped>
.record-detail {
    background: var(--bg-page);
    min-height: 100%;
}

.detail-content {
    padding: 0 24px 24px;
}

.detail-card {
    margin-top: 16px;
}

.detail-card:first-child {
    margin-top: 0;
}

.error-card {
    border-color: #ff4d4f;
}

.error-card :deep(.ant-card-head) {
    border-color: #ff4d4f;
    color: #ff4d4f;
}

.token-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
}

.token-icon {
    font-size: 14px;
}

.token-icon.input {
    color: var(--accent-primary);
}

.token-icon.output {
    color: #52c41a;
}
</style>
