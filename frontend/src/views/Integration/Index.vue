<template>
    <div class="integration">
        <div class="page-header">
            <h2 class="page-title">接入配置</h2>
            <p class="page-desc">以下是当前服务的 API 接入端点，根据您的客户端类型选择对应协议。</p>
        </div>

        <a-row :gutter="[0, 24]">
            <!-- OpenAI 协议 -->
            <a-col :span="24">
                <a-card class="endpoint-card">
                    <template #title>
                        <div class="card-title">
                            <span class="protocol-badge openai">OpenAI</span>
                            <span>OpenAI 兼容端点</span>
                        </div>
                    </template>
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
                </a-card>
            </a-col>

            <!-- Anthropic 协议 -->
            <a-col :span="24">
                <a-card class="endpoint-card">
                    <template #title>
                        <div class="card-title">
                            <span class="protocol-badge anthropic">Anthropic</span>
                            <span>Anthropic 兼容端点</span>
                        </div>
                    </template>
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
                </a-card>
            </a-col>

            <!-- 使用说明 -->
            <a-col :span="24">
                <a-card title="使用说明" class="notes-card">
                    <a-alert
                        type="info"
                        show-icon
                        message="模型名称"
                        description="请求体中的 model 字段需填写在网关后台配置的模型名称，而非上游供应商的原始模型名称。"
                        style="margin-bottom: 12px;"
                    />
                    <a-alert
                        type="info"
                        show-icon
                        message="Token 获取"
                        description="用户 Token 可在「用户管理」页面查看或创建。"
                    />
                </a-card>
            </a-col>
        </a-row>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { message } from 'ant-design-vue/es';
import { CopyOutlined } from '@ant-design/icons-vue';
import { getBaseURL } from '@/utils/request';

const baseUrl = computed(() => getBaseURL());

const openaiUrl = computed(() => `${baseUrl.value}/llm/v1/chat/completions`);
const anthropicUrl = computed(() => `${baseUrl.value}/llm/v1/messages`);

const openaiCurlExample = computed(() =>
    `curl ${openaiUrl.value} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer YOUR_USER_TOKEN" \\
  -d '{
    "model": "your-model-name",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'`
);

const anthropicCurlExample = computed(() =>
    `curl ${anthropicUrl.value} \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_USER_TOKEN" \\
  -H "anthropic-version: 2023-06-01" \\
  -d '{
    "model": "your-model-name",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`
);

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

.protocol-badge {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.5px;
}

.protocol-badge.openai {
    background: var(--accent-primary-soft);
    color: var(--accent-primary);
    border: 1px solid var(--accent-primary-border);
}

.protocol-badge.anthropic {
    background: var(--accent-warning-soft);
    color: var(--accent-warning);
    border: 1px solid var(--accent-warning-border);
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
