<template>
    <div class="api-test">
        <a-row :gutter="16" class="test-container">
            <!-- 左侧：请求配置 -->
            <a-col :span="12" class="config-panel">
                <a-card title="请求配置" :body-style="{ padding: '16px' }">
                    <a-form layout="vertical">
                        <a-form-item label="API 格式">
                            <a-radio-group v-model:value="apiTestStore.config.format">
                                <a-radio-button value="openai">OpenAI</a-radio-button>
                                <a-radio-button value="anthropic">Anthropic</a-radio-button>
                            </a-radio-group>
                        </a-form-item>

                        <a-form-item label="模型">
                            <a-select
                                v-model:value="apiTestStore.config.model"
                                placeholder="选择模型"
                                :loading="modelsLoading"
                                show-search
                            >
                                <a-select-option
                                    v-for="model in models"
                                    :key="model.id"
                                    :value="model.name"
                                >
                                    {{ model.name }}
                                </a-select-option>
                            </a-select>
                        </a-form-item>

                        <a-form-item label="消息">
                            <div
                                v-for="(msg, index) in apiTestStore.config.messages"
                                :key="index"
                                class="message-item"
                            >
                                <a-select
                                    v-model:value="msg.role"
                                    style="width: 100px"
                                    class="message-role"
                                >
                                    <a-select-option value="system">System</a-select-option>
                                    <a-select-option value="user">User</a-select-option>
                                    <a-select-option value="assistant">Assistant</a-select-option>
                                </a-select>
                                <a-textarea
                                    v-model:value="msg.content"
                                    :rows="2"
                                    placeholder="输入消息内容"
                                    class="message-content"
                                />
                                <a-button
                                    type="link"
                                    danger
                                    @click="removeMessage(index)"
                                    :disabled="apiTestStore.config.messages.length <= 1"
                                >
                                    删除
                                </a-button>
                            </div>
                            <a-button type="dashed" block @click="addMessage">
                                添加消息
                            </a-button>
                        </a-form-item>

                        <a-row :gutter="16">
                            <a-col :span="12">
                                <a-form-item label="Temperature">
                                    <a-slider
                                        v-model:value="apiTestStore.config.temperature"
                                        :min="0"
                                        :max="2"
                                        :step="0.1"
                                    />
                                    <div class="slider-value">{{ apiTestStore.config.temperature }}</div>
                                </a-form-item>
                            </a-col>
                            <a-col :span="12">
                                <a-form-item label="Max Tokens">
                                    <a-input-number
                                        v-model:value="apiTestStore.config.max_tokens"
                                        :min="1"
                                        :max="8192"
                                        style="width: 100%"
                                    />
                                </a-form-item>
                            </a-col>
                        </a-row>

                        <a-form-item>
                            <a-space>
                                <a-checkbox v-model:checked="apiTestStore.config.stream">
                                    流式响应
                                </a-checkbox>
                            </a-space>
                        </a-form-item>

                        <a-form-item>
                            <a-button
                                type="primary"
                                :loading="apiTestStore.loading"
                                :disabled="!apiTestStore.canSend"
                                @click="handleSend"
                                block
                            >
                                发送请求
                            </a-button>
                        </a-form-item>
                    </a-form>
                </a-card>

                <!-- 历史记录 -->
                <a-card
                    title="历史记录"
                    class="history-card"
                    :body-style="{ padding: '12px' }"
                    v-if="apiTestStore.hasHistory"
                >
                    <template #extra>
                        <a-button type="link" danger size="small" @click="handleClearHistory">
                            清空
                        </a-button>
                    </template>
                    <a-list
                        :data-source="apiTestStore.history.slice(0, 5)"
                        size="small"
                    >
                        <template #renderItem="{ item }">
                            <a-list-item>
                                <a-list-item-meta>
                                    <template #title>
                                        <a-space>
                                            <span>{{ formatTime(item.timestamp) }}</span>
                                            <a-tag :color="getStatusColor(item.status)">
                                                {{ getStatusText(item.status) }}
                                            </a-tag>
                                        </a-space>
                                    </template>
                                    <template #description>
                                        {{ item.request.model }} | {{ item.request.format }}
                                    </template>
                                </a-list-item-meta>
                                <template #actions>
                                    <a-button type="link" size="small" @click="loadHistory(item)">
                                        加载
                                    </a-button>
                                </template>
                            </a-list-item>
                        </template>
                    </a-list>
                </a-card>
            </a-col>

            <!-- 右侧：响应展示 -->
            <a-col :span="12" class="response-panel">
                <StreamOutput
                    :content="apiTestStore.responseText"
                    :error="apiTestStore.error"
                    :loading="apiTestStore.loading"
                    @stop="handleStop"
                    @clear="handleClear"
                />
            </a-col>
        </a-row>
    </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useApiTestStore } from '@/stores/apiTest';
import { listModels } from '@/api/model';
import StreamOutput from '@/components/common/StreamOutput.vue';
import type { ApiTestHistory } from '@/types/gateway';
import type { Model } from '@/types/model';
import { normalizeListResponse } from '@/utils/listResponse';
import { notifyRequestError, notifySuccess } from '@/utils/requestFeedback';

const apiTestStore = useApiTestStore();
const models = ref<Model[]>([]);
const modelsLoading = ref(false);

onMounted(() => {
    loadModels();
});

async function loadModels() {
    modelsLoading.value = true;
    try {
        models.value = normalizeListResponse(await listModels({ page: 1, pageSize: 1000 })).list;
    } catch (error) {
        notifyRequestError(error, '加载模型列表失败');
    } finally {
        modelsLoading.value = false;
    }
}

function addMessage() {
    apiTestStore.config.messages.push({
        role: 'user',
        content: '',
    });
}

function removeMessage(index: number) {
    apiTestStore.config.messages.splice(index, 1);
}

async function handleSend() {
    const request = {
        format: apiTestStore.config.format,
        model: apiTestStore.config.model,
        messages: apiTestStore.config.messages.filter(m => m.content.trim()),
        temperature: apiTestStore.config.temperature,
        max_tokens: apiTestStore.config.max_tokens,
        stream: apiTestStore.config.stream,
    };

    await apiTestStore.sendRequest(request);
}

function handleStop() {
    // 目前无法真正停止，只是重置状态
    apiTestStore.loading = false;
}

function handleClear() {
    apiTestStore.clearResponse();
}

function handleClearHistory() {
    apiTestStore.clearHistory();
    notifySuccess('历史记录已清空');
}

function loadHistory(item: ApiTestHistory) {
    const request = apiTestStore.loadHistoryItem(item);
    apiTestStore.updateConfig({
        format: request.format,
        model: request.model,
        messages: [...request.messages],
        temperature: request.temperature ?? 0.7,
        max_tokens: request.max_tokens ?? 2048,
        stream: request.stream ?? true,
    });
    notifySuccess('已加载历史配置');
}

function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
}

function getStatusColor(status: string): string {
    switch (status) {
        case 'success':
            return 'success';
        case 'error':
            return 'error';
        case 'pending':
        default:
            return 'processing';
    }
}

function getStatusText(status: string): string {
    switch (status) {
        case 'success':
            return '成功';
        case 'error':
            return '失败';
        case 'pending':
        default:
            return '进行中';
    }
}
</script>

<style scoped>
.api-test {
    height: 100%;
    padding: 24px;
    background: var(--bg-page);
}

.test-container {
    height: 100%;
}

.config-panel {
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.response-panel {
    height: calc(100vh - 120px);
}

.message-item {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin-bottom: 8px;
}

.message-role {
    flex-shrink: 0;
}

.message-content {
    flex: 1;
}

.slider-value {
    text-align: center;
    color: var(--text-secondary);
    font-size: 12px;
}

.history-card {
    max-height: 300px;
    overflow: auto;
}
</style>
