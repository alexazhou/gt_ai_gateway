<template>
    <div class="record-detail">
        <a-page-header
            title="请求记录详情"
            @back="handleBack"
        >
            <template #extra>
                <a-space>
                    <a-button
                        :disabled="currentRecordId <= 1"
                        @click="navigateToRecord(currentRecordId - 1)"
                    >
                        上一个请求
                    </a-button>
                    <a-button
                        :disabled="currentRecordId <= 0"
                        @click="navigateToRecord(currentRecordId + 1)"
                    >
                        下一个请求
                    </a-button>
                </a-space>
            </template>
        </a-page-header>

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
                        <a-descriptions-item label="供应商模型">
                            {{ recordStore.currentRecord.vendor_model_name || '-' }}
                        </a-descriptions-item>
                        <a-descriptions-item label="协议">
                            <div v-if="recordStore.currentRecord.client_format" class="protocol-row">
                                <a-tag>{{ recordStore.currentRecord.client_format.toUpperCase() }}</a-tag>
                                <template v-if="recordStore.currentRecord.upstream_format">
                                    <span class="protocol-arrow">→</span>
                                    <a-tag color="orange">{{ recordStore.currentRecord.upstream_format.toUpperCase() }}</a-tag>
                                </template>
                            </div>
                            <span v-else>-</span>
                        </a-descriptions-item>
                        <a-descriptions-item label="创建时间">
                            {{ formatDate(recordStore.currentRecord.created_at) }}
                        </a-descriptions-item>
                        <a-descriptions-item label="Token">
                            <div v-if="usageTokens" class="token-row">
                                <span class="token-item" title="输入 Token">
                                    <ArrowUpOutlined class="token-icon input" />
                                    {{ usageTokens.prompt }}<template v-if="usageTokens.cacheReadTokens !== null"> (+ {{ usageTokens.cacheReadTokens!.toLocaleString() }})</template>
                                </span>
                                <span class="token-divider">/</span>
                                <span class="token-item" title="输出 Token">
                                    <ArrowDownOutlined class="token-icon output" />
                                    {{ usageTokens.output }}
                                </span>
                            </div>
                            <span v-else>-</span>
                        </a-descriptions-item>
                        <a-descriptions-item label="缓存命中">
                            {{ usageTokens?.cacheHitRate != null ? usageTokens!.cacheHitRate!.toFixed(1) + '%' : '-' }}
                        </a-descriptions-item>
                        <a-descriptions-item label="总耗时">
                            {{ totalDuration !== null ? totalDuration.toLocaleString() + 'ms' : '-' }}
                        </a-descriptions-item>
                        <a-descriptions-item label="首 Token 延迟">
                            {{ recordStore.currentRecord.first_token_latency ? recordStore.currentRecord.first_token_latency + 'ms' : '-' }}
                        </a-descriptions-item>
                    </a-descriptions>
                </a-card>

                <!-- 请求与响应数据 -->
                <a-card class="detail-card request-tabs-card">
                    <a-tabs v-model:activeKey="activeRequestTab">
                        <template #rightExtra>
                            <a-space v-if="activeRequestTab === 'request_json'">
                                <a-button type="link" size="small" @click="isRequestExpanded = !isRequestExpanded">
                                    {{ isRequestExpanded ? '收起' : '展开' }}
                                </a-button>
                                <a-button type="link" size="small" @click="requestJsonRef?.handleCopy()">
                                    复制
                                </a-button>
                                <a-button
                                    type="link"
                                    size="small"
                                    :disabled="!recordStore.currentRecord?.request_data"
                                    @click="downloadJson(recordStore.currentRecord?.request_data, 'request')"
                                >
                                    <template #icon><DownloadOutlined /></template>
                                    下载
                                </a-button>
                            </a-space>
                            <a-space v-else-if="activeRequestTab === 'response_json'">
                                <a-button type="link" size="small" @click="isResponseExpanded = !isResponseExpanded">
                                    {{ isResponseExpanded ? '收起' : '展开' }}
                                </a-button>
                                <a-button type="link" size="small" @click="responseJsonRef?.handleCopy()">
                                    复制
                                </a-button>
                                <a-button
                                    type="link"
                                    size="small"
                                    :disabled="!recordStore.currentRecord?.response_data"
                                    @click="downloadJson(recordStore.currentRecord?.response_data, 'response')"
                                >
                                    <template #icon><DownloadOutlined /></template>
                                    下载
                                </a-button>
                            </a-space>
                        </template>

                        <a-tab-pane key="visual" tab="可视化对话" v-if="Array.isArray(conversationData) ? conversationData.length > 0 : conversationData.messages.length > 0">
                            <div class="visualization-container">
                                <iframe 
                                    ref="viewerIframe" 
                                    src="/data_viewer/dist/index.html" 
                                    @load="onIframeLoad" 
                                    frameborder="0"
                                    class="visualization-iframe"
                                ></iframe>
                            </div>
                        </a-tab-pane>

                        <a-tab-pane key="request_json" tab="请求数据 (JSON)">
                            <div class="json-pane-content">
                                <JsonViewer ref="requestJsonRef" :data="recordStore.currentRecord.request_data" :expanded="isRequestExpanded" />
                            </div>
                        </a-tab-pane>

                        <a-tab-pane key="response_json" tab="响应数据 (JSON)">
                            <div class="json-pane-content">
                                <JsonViewer ref="responseJsonRef" :data="recordStore.currentRecord.response_data" :expanded="isResponseExpanded" />
                            </div>
                        </a-tab-pane>

                        <a-tab-pane v-if="recordStore.currentRecord.status === 'failed'" key="error" tab="报错信息">
                            <div class="error-pane-content">
                                <div v-if="recordStore.currentRecord.failed_code" class="error-type">
                                    {{ FAILED_CODE_LABELS[recordStore.currentRecord.failed_code] ?? recordStore.currentRecord.failed_code }}
                                </div>
                                <div class="error-message-text">{{ getErrorMessage(recordStore.currentRecord.response_data) }}</div>
                            </div>
                        </a-tab-pane>
                    </a-tabs>
                </a-card>
            </div>

            <a-empty v-else description="请求未找到" />
        </a-spin>
    </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, watch, ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { DownloadOutlined, ArrowUpOutlined, ArrowDownOutlined } from '@ant-design/icons-vue';
import { useRecordStore } from '@/stores/record';
import { formatDate } from '@/utils/format';
import JsonViewer from '@/components/common/JsonViewer.vue';
import { message } from 'ant-design-vue/es';

const router = useRouter();
const route = useRoute();
const recordStore = useRecordStore();

const viewerIframe = ref<HTMLIFrameElement | null>(null);
const activeRequestTab = ref<string>('request_json');

const requestJsonRef = ref<any>(null);
const responseJsonRef = ref<any>(null);

const isRequestExpanded = ref(true);
const isResponseExpanded = ref(true);

const conversationData = computed(() => {
    const messages: any[] = [];
    let system: any = undefined;
    try {
        if (recordStore.currentRecord?.request_data) {
            const req = JSON.parse(recordStore.currentRecord.request_data);
            if (req.messages && Array.isArray(req.messages)) {
                messages.push(...req.messages);
            }
            if (req.system != null) {
                system = req.system;
            }
        }
    } catch(e) {}
    try {
        if (recordStore.currentRecord?.response_data) {
            const res = JSON.parse(recordStore.currentRecord.response_data);
            if (res.choices && res.choices.length > 0 && res.choices[0].message) {
                messages.push(res.choices[0].message);
            } else if (res.message) {
                messages.push(res.message);
            }
        }
    } catch(e) {}
    return system !== undefined ? { system, messages } : messages;
});

function getMessageCount(data: any): number {
    if (Array.isArray(data)) return data.length;
    return data?.messages?.length ?? 0;
}

function onIframeLoad() {
    if (viewerIframe.value && viewerIframe.value.contentWindow) {
        setTimeout(() => {
            const bridge = (viewerIframe.value!.contentWindow as any).gt_bridge;
            if (bridge && typeof bridge.setLlmData === 'function') {
                bridge.setLlmData(JSON.parse(JSON.stringify(conversationData.value)));
            }
        }, 300);
    }
}

watch(conversationData, (newVal) => {
    if (getMessageCount(newVal) > 0) {
        activeRequestTab.value = 'visual';
    } else if (recordStore.currentRecord?.status === 'failed') {
        activeRequestTab.value = 'error';
    } else {
        activeRequestTab.value = 'request_json';
    }

    if (getMessageCount(newVal) > 0 && viewerIframe.value && viewerIframe.value.contentWindow) {
        const bridge = (viewerIframe.value.contentWindow as any).gt_bridge;
        if (bridge && typeof bridge.setLlmData === 'function') {
            bridge.setLlmData(JSON.parse(JSON.stringify(newVal)));
        }
    }
}, { deep: true, immediate: true });

const usageTokens = computed(() => {
    const usage = recordStore.currentRecord?.usage;
    if (!usage) return null;
    try {
        const u = JSON.parse(usage);
        if (u.prompt_tokens === undefined && u.completion_tokens === undefined) return null;
        const prompt: number = u.prompt_tokens ?? 0;
        const output: number = u.completion_tokens ?? 0;
        const cacheRead = u.cache_read_tokens;
        let cacheHitRate: number | null = null;
        if (cacheRead !== undefined && cacheRead !== null) {
            const total = prompt + cacheRead;
            cacheHitRate = total > 0 ? Math.floor(cacheRead / total * 1000) / 10 : 0;
        }
        return { prompt, output, cacheHitRate, cacheReadTokens: cacheRead ?? null };
    } catch {
        return null;
    }
});

const totalDuration = computed(() => {
    const r = recordStore.currentRecord;
    if (!r?.start_at || !r?.end_at) return null;
    const start = new Date(r.start_at).getTime();
    const end = new Date(r.end_at).getTime();
    if (isNaN(start) || isNaN(end)) return null;
    return end - start;
});

const currentRecordId = computed<number>(() => {
    const id = Number.parseInt(route.params.id as string, 10);
    return Number.isNaN(id) ? 0 : id;
});

watch(
    () => route.params.id,
    (idValue) => {
        const id = Number.parseInt(idValue as string, 10);
        if (Number.isNaN(id)) {
            recordStore.clearCurrentRecord();
            return;
        }

        void recordStore.fetchRecordDetail(id);
    },
    { immediate: true }
);

function navigateToRecord(targetId: number) {
    if (targetId <= 0) {
        return;
    }

    void router.push({
        name: 'RecordDetail',
        params: { id: String(targetId) },
    });
}

function handleBack() {
    void router.push({ name: 'RecordList' });
}

onUnmounted(() => {
    recordStore.clearCurrentRecord();
});

const FAILED_CODE_LABELS: Record<string, string> = {
    client_disconnected: '客户端断开连接',
    upstream_disconnected: '上游断开连接',
    stream_incomplete: '流式响应不完整',
};


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

.error-pane-content {
    padding: 8px 0;
}

.error-type {
    color: #8c8c8c;
    font-size: 13px;
    margin-bottom: 6px;
}

.error-message-text {
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

.token-row {
    display: flex;
    align-items: center;
}

.token-divider {
    margin: 0 6px;
    color: #d9d9d9;
    line-height: 1;
}

.protocol-row {
    display: flex;
    align-items: center;
    gap: 4px;
}

.protocol-row :deep(.ant-tag) {
    display: inline-flex;
    align-items: center;
    margin: 0;
}

.protocol-arrow {
    color: #8c8c8c;
    font-size: 12px;
    line-height: 1;
}

.visualization-container {
    height: 700px;
    width: 100%;
}

.visualization-iframe {
    width: 100%;
    height: 100%;
    border: 1px solid var(--border-color, #f0f0f0);
    border-radius: 8px;
}

.request-tabs-card :deep(.ant-card-body) {
    padding-top: 0;
}

.request-tabs-card :deep(.ant-tabs-nav) {
    margin-bottom: 16px;
}

.json-pane-content {
    margin-top: 8px;
}
</style>
