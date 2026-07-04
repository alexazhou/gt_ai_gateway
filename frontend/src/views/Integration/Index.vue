<template>
    <div class="integration">
        <div class="page-header">
            <h2 class="page-title">接入配置</h2>
            <p class="page-desc">以下是当前服务的 API 接入端点，根据您的客户端类型选择对应协议。</p>
        </div>

        <a-card class="endpoint-card" :bodyStyle="{ padding: '16px 24px 24px' }">
            <a-tabs v-model:activeKey="activeTab">
                <!-- OpenAI 协议 -->
                <a-tab-pane key="openai" tab="OpenAI">
                    <a-descriptions :column="1" bordered size="middle">
                        <a-descriptions-item label="接入地址">
                            <div class="url-row">
                                <a-typography-text code class="url-text">{{ openaiUrl }}</a-typography-text>
                                <a-button type="link" size="small" @click="copyText(openaiUrl, 'OpenAI 接入地址')">
                                    <CopyOutlined /> 复制
                                </a-button>
                            </div>
                        </a-descriptions-item>
                        <a-descriptions-item label="请求方式">POST</a-descriptions-item>
                        <a-descriptions-item label="认证方式">
                            <a-typography-text code>Authorization: Bearer YOUR_USER_TOKEN</a-typography-text>
                        </a-descriptions-item>
                        <a-descriptions-item label="请求模型">
                            <a-select
                                v-model:value="selectedModelName"
                                style="width: 240px"
                                placeholder="请选择模型"
                                :options="modelList.map(m => ({ label: m.name, value: m.name }))"
                            >
                                <template #notFoundContent>
                                    <div style="text-align: center; padding: 8px 0;">
                                        <a-typography-text type="secondary">暂无可用模型，</a-typography-text>
                                        <router-link to="/model">去添加</router-link>
                                    </div>
                                </template>
                            </a-select>
                        </a-descriptions-item>
                        <a-descriptions-item label="请求用户">
                            <a-select
                                v-model:value="selectedUserToken"
                                style="width: 240px"
                                placeholder="请选择用户"
                                :options="userList.map(u => ({ label: u.name, value: u.token }))"
                            >
                                <template #notFoundContent>
                                    <div style="text-align: center; padding: 8px 0;">
                                        <a-typography-text type="secondary">暂无可用用户，</a-typography-text>
                                        <router-link to="/user">去添加</router-link>
                                    </div>
                                </template>
                            </a-select>
                        </a-descriptions-item>
                        <a-descriptions-item label="使用示例">
                            <div class="code-block-wrapper">
                                <a-button
                                    type="link"
                                    size="small"
                                    class="copy-code-btn"
                                    @click="copyText(openaiCurlExample, 'OpenAI 示例')"
                                >
                                    <CopyOutlined /> 复制
                                </a-button>
                                <pre class="code-block">{{ openaiCurlExample }}</pre>
                            </div>
                        </a-descriptions-item>
                    </a-descriptions>
                </a-tab-pane>

                <!-- Anthropic 协议 -->
                <a-tab-pane key="anthropic" tab="Anthropic">
                    <a-descriptions :column="1" bordered size="middle">
                        <a-descriptions-item label="接入地址">
                            <div class="url-row">
                                <a-typography-text code class="url-text">{{ anthropicUrl }}</a-typography-text>
                                <a-button type="link" size="small" @click="copyText(anthropicUrl, 'Anthropic 接入地址')">
                                    <CopyOutlined /> 复制
                                </a-button>
                            </div>
                        </a-descriptions-item>
                        <a-descriptions-item label="请求方式">POST</a-descriptions-item>
                        <a-descriptions-item label="认证方式">
                            <a-space direction="vertical" :size="4">
                                <div>
                                    推荐：<a-typography-text code>x-api-key: YOUR_USER_TOKEN</a-typography-text>
                                </div>
                                <div>
                                    或：<a-typography-text code>Authorization: Bearer YOUR_USER_TOKEN</a-typography-text>
                                </div>
                            </a-space>
                        </a-descriptions-item>
                        <a-descriptions-item label="请求模型">
                            <a-select
                                v-model:value="selectedModelName"
                                style="width: 240px"
                                placeholder="请选择模型"
                                :options="modelList.map(m => ({ label: m.name, value: m.name }))"
                            >
                                <template #notFoundContent>
                                    <div style="text-align: center; padding: 8px 0;">
                                        <a-typography-text type="secondary">暂无可用模型，</a-typography-text>
                                        <router-link to="/model">去添加</router-link>
                                    </div>
                                </template>
                            </a-select>
                        </a-descriptions-item>
                        <a-descriptions-item label="请求用户">
                            <a-select
                                v-model:value="selectedUserToken"
                                style="width: 240px"
                                placeholder="请选择用户"
                                :options="userList.map(u => ({ label: u.name, value: u.token }))"
                            >
                                <template #notFoundContent>
                                    <div style="text-align: center; padding: 8px 0;">
                                        <a-typography-text type="secondary">暂无可用用户，</a-typography-text>
                                        <router-link to="/user">去添加</router-link>
                                    </div>
                                </template>
                            </a-select>
                        </a-descriptions-item>
                        <a-descriptions-item label="使用示例">
                            <div class="code-block-wrapper">
                                <a-button
                                    type="link"
                                    size="small"
                                    class="copy-code-btn"
                                    @click="copyText(anthropicCurlExample, 'Anthropic 示例')"
                                >
                                    <CopyOutlined /> 复制
                                </a-button>
                                <pre class="code-block">{{ anthropicCurlExample }}</pre>
                            </div>
                        </a-descriptions-item>
                    </a-descriptions>
                </a-tab-pane>

                <!-- Responses 协议 -->
                <a-tab-pane key="responses" tab="Responses">
                    <a-descriptions :column="1" bordered size="middle">
                        <a-descriptions-item label="接入地址">
                            <div class="url-row">
                                <a-typography-text code class="url-text">{{ responsesUrl }}</a-typography-text>
                                <a-button type="link" size="small" @click="copyText(responsesUrl, 'Responses 接入地址')">
                                    <CopyOutlined /> 复制
                                </a-button>
                            </div>
                        </a-descriptions-item>
                        <a-descriptions-item label="请求方式">POST</a-descriptions-item>
                        <a-descriptions-item label="认证方式">
                            <a-typography-text code>Authorization: Bearer YOUR_USER_TOKEN</a-typography-text>
                        </a-descriptions-item>
                        <a-descriptions-item label="请求模型">
                            <a-select
                                v-model:value="selectedModelName"
                                style="width: 240px"
                                placeholder="请选择模型"
                                :options="modelList.map(m => ({ label: m.name, value: m.name }))"
                            >
                                <template #notFoundContent>
                                    <div style="text-align: center; padding: 8px 0;">
                                        <a-typography-text type="secondary">暂无可用模型，</a-typography-text>
                                        <router-link to="/model">去添加</router-link>
                                    </div>
                                </template>
                            </a-select>
                        </a-descriptions-item>
                        <a-descriptions-item label="请求用户">
                            <a-select
                                v-model:value="selectedUserToken"
                                style="width: 240px"
                                placeholder="请选择用户"
                                :options="userList.map(u => ({ label: u.name, value: u.token }))"
                            >
                                <template #notFoundContent>
                                    <div style="text-align: center; padding: 8px 0;">
                                        <a-typography-text type="secondary">暂无可用用户，</a-typography-text>
                                        <router-link to="/user">去添加</router-link>
                                    </div>
                                </template>
                            </a-select>
                        </a-descriptions-item>
                        <a-descriptions-item label="使用示例">
                            <div class="code-block-wrapper">
                                <a-button
                                    type="link"
                                    size="small"
                                    class="copy-code-btn"
                                    @click="copyText(responsesCurlExample, 'Responses 示例')"
                                >
                                    <CopyOutlined /> 复制
                                </a-button>
                                <pre class="code-block">{{ responsesCurlExample }}</pre>
                            </div>
                        </a-descriptions-item>
                    </a-descriptions>
                </a-tab-pane>
            </a-tabs>
        </a-card>
    </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { message } from 'ant-design-vue/es';
import { CopyOutlined } from '@ant-design/icons-vue';
import { getBaseURL } from '@/utils/request';
import { listUsers } from '@/api/user';
import { listModels } from '@/api/model';
import type { User } from '@/types/user';
import type { Model } from '@/types/model';

const activeTab = ref('openai');

const userList = ref<User[]>([]);
const modelList = ref<Model[]>([]);
const selectedUserToken = ref<string>('');
const selectedModelName = ref<string>('');

onMounted(async () => {
    try {
        const [usersRes, modelsRes] = await Promise.all([
            listUsers({ page: 1, pageSize: 100 }),
            listModels({ page: 1, pageSize: 100 })
        ]);
        
        userList.value = Array.isArray(usersRes) ? usersRes : (usersRes.list || []);
        modelList.value = Array.isArray(modelsRes) ? modelsRes : (modelsRes.list || []);

        if (userList.value.length > 0) {
            selectedUserToken.value = userList.value[0]!.token;
        }
        if (modelList.value.length > 0) {
            selectedModelName.value = modelList.value[0]!.name;
        }
    } catch (e) {
        console.error('Failed to load users and models', e);
    }
});

const baseUrl = computed(() => {
    let url = getBaseURL();
    if (url === '/api' && import.meta.env.DEV) {
        return 'http://127.0.0.1:8720';
    }
    if (!url.startsWith('http')) {
        url = window.location.origin + (url.startsWith('/') ? url : `/${url}`);
    }
    return url.replace(/\/$/, '');
});

const openaiUrl = computed(() => `${baseUrl.value}/llm/v1/chat/completions`);
const anthropicUrl = computed(() => `${baseUrl.value}/llm/v1/messages`);
const responsesUrl = computed(() => `${baseUrl.value}/llm/v1/responses`);

const openaiCurlExample = computed(() => {
    const token = selectedUserToken.value || 'YOUR_USER_TOKEN';
    const model = selectedModelName.value || 'your-model-name';
    return `curl ${openaiUrl.value} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${token}" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'`;
});

const anthropicCurlExample = computed(() => {
    const token = selectedUserToken.value || 'YOUR_USER_TOKEN';
    const model = selectedModelName.value || 'your-model-name';
    return `curl ${anthropicUrl.value} \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: ${token}" \\
  -H "anthropic-version: 2023-06-01" \\
  -d '{
    "model": "${model}",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`;
});

const responsesCurlExample = computed(() => {
    const token = selectedUserToken.value || 'YOUR_USER_TOKEN';
    const model = selectedModelName.value || 'your-model-name';
    return `curl ${responsesUrl.value} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${token}" \\
  -d '{
    "model": "${model}",
    "input": "Hello!",
    "stream": true
  }'`;
});

async function copyText(text: string, label: string) {
    try {
        await navigator.clipboard.writeText(text);
        message.success(`${label}已复制`);
    } catch {
        message.error('复制失败，请手动复制');
    }
}
</script>

<style scoped>
.integration {
    padding: 24px;
    max-width: 900px;
    background: var(--bg-page);
    min-height: 100%;
}

.page-header {
    margin-bottom: 24px;
}

.page-title {
    margin: 0 0 4px;
    font-size: 20px;
    font-weight: 600;
    color: var(--text-primary);
}

.page-desc {
    margin: 0;
    color: var(--text-secondary);
    font-size: 14px;
}

.endpoint-card {
    border-radius: 12px;
}

.card-title {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 16px;
    font-weight: 600;
}

.url-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}

.url-text {
    font-size: 13px;
    word-break: break-all;
}

.code-block-wrapper {
    position: relative;
}

.copy-code-btn {
    position: absolute;
    top: 4px;
    right: 4px;
    z-index: 1;
}

.code-block {
    background: var(--bg-code);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 14px 16px;
    font-size: 12px;
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    line-height: 1.6;
    white-space: pre;
    overflow-x: auto;
    margin: 0;
    color: var(--text-primary);
}

.notes-card {
    border-radius: 12px;
}
</style>
