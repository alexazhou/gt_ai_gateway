<template>
    <a-modal
        v-model:open="visible"
        :title="modalTitle"
        :footer="null"
        width="600px"
    >
        <div class="test-dialog">
            <div class="test-config">
                <a-form layout="vertical">
                    <!-- Model mode: read-only info block -->
                    <template v-if="mode === 'model'">
                        <div class="model-info">
                            <div class="info-row">
                                <span class="info-label">模型名称</span>
                                <span class="info-value">{{ modelName }}</span>
                            </div>
                        </div>
                    </template>

                    <a-form-item :label="mode === 'model' ? '客户端请求协议' : '向服务端请求协议'">
                        <a-radio-group v-model:value="format">
                            <a-radio-button value="openai">OpenAI</a-radio-button>
                            <a-radio-button value="anthropic">Anthropic</a-radio-button>
                            <a-radio-button value="responses">Responses</a-radio-button>
                        </a-radio-group>
                    </a-form-item>

                    <!-- Vendor mode: editable model select -->
                    <template v-if="mode === 'vendor'">
                        <a-form-item label="测试模型">
                            <a-select
                                v-model:value="testModel"
                                placeholder="请选择或直接输入模型名称"
                                show-search
                                allow-clear
                                :loading="modelsLoading"
                                :options="selectOptions"
                                @search="handleSearch"
                                :filter-option="false"
                                option-label-prop="value"
                            >
                                <template #option="{ value, isCustom }">
                                    <span v-if="isCustom" style="color: var(--accent-primary)">使用自定义模型: </span>
                                    {{ value }}
                                </template>
                            </a-select>
                            <div class="hint-text">您可以从下拉列表中选择，也可以直接输入新的模型名称进行测试</div>
                        </a-form-item>
                    </template>

                    <a-button
                        type="primary"
                        :loading="loading"
                        :disabled="testButtonDisabled"
                        @click="handleTest"
                        block
                    >
                        开始测试
                    </a-button>
                </a-form>
            </div>

            <div v-if="result" class="test-result">
                <a-divider>测试结果</a-divider>
                <div class="result-summary">
                    <a-space direction="vertical" style="width: 100%">
                        <a-space>
                            <a-badge :status="result.success ? 'success' : 'error'" />
                            <span :class="['status-text', result.success ? 'success' : 'error']">
                                {{ result.success ? '连接成功' : '连接失败' }}
                            </span>
                            <span v-if="result.status" class="status-code">
                                HTTP {{ result.status }}
                            </span>
                            <span v-if="result.duration" class="duration">
                                耗时: {{ result.duration }}ms
                            </span>
                        </a-space>
                        <div v-if="result.converted_from && result.converted_to" class="result-convert">
                            <span class="convert-label">协议转换:</span>
                            <code class="convert-text">{{ result.converted_from.toUpperCase() }} → {{ result.converted_to.toUpperCase() }}</code>
                        </div>
                        <div v-if="result.url" class="result-url">
                            <span class="url-label">实际 URL:</span>
                            <code class="url-text">{{ result.url }}</code>
                        </div>
                        <div v-if="result.proxy" class="result-proxy">
                            <span class="proxy-label">代理:</span>
                            <code class="proxy-text">{{ result.proxy.type.toUpperCase() }} {{ result.proxy.url }}</code>
                        </div>
                    </a-space>
                </div>

                <div class="result-detail">
                    <a-tabs v-model:activeKey="activeTab" size="small">
                        <a-tab-pane key="response" tab="响应">
                            <pre class="response-body">{{ formattedResponse }}</pre>
                        </a-tab-pane>
                        <a-tab-pane v-if="result.request_headers || result.request_body" key="request" tab="请求">
                            <div class="tab-action">
                                <a-button
                                    type="link"
                                    size="small"
                                    class="copy-btn"
                                    @click="copyRequestText"
                                >
                                    <CopyOutlined /> 复制
                                </a-button>
                            </div>
                            <pre class="request-body">{{ formattedRequest }}</pre>
                        </a-tab-pane>
                    </a-tabs>
                </div>
            </div>
        </div>
    </a-modal>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { testVendor, listVendorModels } from '@/api/vendor';
import type { VendorTestResponse } from '@/api/vendor';
import type { Vendor, VendorModel } from '@/types/vendor';
import { testModelRoute } from '@/api/model';
import { notifyRequestError, notifySuccess, notifyWarning } from '@/utils/requestFeedback';
import { message as antMessage } from 'ant-design-vue';
import { CopyOutlined } from '@ant-design/icons-vue';

const visible = ref(false);
const loading = ref(false);
const format = ref('openai');
const result = ref<VendorTestResponse | null>(null);
const currentVendor = ref<Vendor | null>(null);
const activeTab = ref('response');

// 测试模式：vendor=供应商直连测试（POST /vendor/:id/test.json）；model=模型路由测试（/llm/*）
const mode = ref<'vendor' | 'model'>('vendor');
const modelName = ref('');

const testModel = ref<string>('');
const vendorModels = ref<VendorModel[]>([]);
const modelsLoading = ref(false);
const searchValue = ref('');

const isModelMode = computed(() => mode.value === 'model');

const modalTitle = computed(() => isModelMode.value ? '模型可用性测试' : '供应商连通性测试');

const testButtonDisabled = computed(() => {
    if (isModelMode.value) {
        // 模型路由测试：走网关路由，只需网关模型名
        return !modelName.value;
    }
    // 供应商直连测试：需要选好供应商和测试模型
    return !currentVendor.value || !testModel.value;
});

const selectOptions = computed(() => {
    const options = vendorModels.value.map(m => ({
        value: m.model_id,
        label: m.model_id,
        isCustom: false,
    }));

    if (searchValue.value && !options.some(o => o.value === searchValue.value)) {
        options.unshift({
            value: searchValue.value,
            label: searchValue.value,
            isCustom: true,
        });
    }

    return options;
});

const formattedResponse = computed(() => {
    const data = result.value?.response || result.value?.error;
    if (!data) return '';
    try {
        if (typeof data === 'object') {
            return JSON.stringify(data, null, 2);
        }
        return String(data);
    } catch {
        return String(data);
    }
});


const formattedRequest = computed(() => {
    const r = result.value;
    if (!r) return '';
    const method = r.request_method || 'POST';
    const url = r.url || '';
    const headers = r.request_headers || {};
    const body = r.request_body;

    const lines: string[] = [];
    lines.push(`${method} ${url}`);
    for (const [key, value] of Object.entries(headers)) {
        lines.push(`${key}: ${value}`);
    }
    if (body !== undefined && body !== null) {
        lines.push('');
        try {
            if (typeof body === 'object') {
                lines.push(JSON.stringify(body, null, 2));
            } else {
                lines.push(String(body));
            }
        } catch {
            lines.push(String(body));
        }
    }
    return lines.join('\n');
});


function copyRequestText() {
    const text = formattedRequest.value;
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
        antMessage.success('已复制请求原文');
    }).catch(() => {
        antMessage.error('复制失败');
    });
}

function openVendorTest(vendor: Vendor, model?: string) {
    mode.value = 'vendor';
    currentVendor.value = vendor;
    visible.value = true;
    result.value = null;
    testModel.value = model ?? '';
    searchValue.value = '';
    activeTab.value = 'response';
    format.value = vendor.type === 'anthropic' ? 'anthropic' : 'openai';

    loadVendorModels(vendor.id, model);
}

function openModelTest(model: string) {
    mode.value = 'model';
    currentVendor.value = null;
    modelName.value = model;
    visible.value = true;
    result.value = null;
    testModel.value = '';
    searchValue.value = '';
    format.value = 'openai';
    activeTab.value = 'response';
}

async function loadVendorModels(vendorId: number, presetModel?: string) {
    modelsLoading.value = true;
    try {
        vendorModels.value = await listVendorModels(vendorId);
        if (presetModel) {
            testModel.value = presetModel;
        } else if (vendorModels.value.length > 0) {
            testModel.value = vendorModels.value[0]?.model_id || '';
        }
    } catch (error) {
        notifyRequestError(error, '加载模型列表失败');
    } finally {
        modelsLoading.value = false;
    }
}

watch(format, () => {
    result.value = null;
});

function handleSearch(val: string) {
    searchValue.value = val;
}

// 模型路由测试：走专用接口（真实网关路由 + failover），返回上游实际请求快照与上游响应
async function runRoutingTest() {
    const model = modelName.value;
    if (!model) return;

    loading.value = true;
    result.value = null;
    const startTime = Date.now();

    try {
        const res = await testModelRoute(model, format.value);
        result.value = res;
        if (res.success) {
            notifySuccess('测试完成，模型正常响应');
        } else {
            if (res.status) {
                notifyWarning(`测试完成，但上游返回错误 (HTTP ${res.status})`);
            } else {
                notifyWarning('测试请求失败 (底层网络报错)');
            }
        }
    } catch (error) {
        const requestError = notifyRequestError(error, '测试请求发送失败');
        result.value = {
            success: false,
            duration: Date.now() - startTime,
            error: requestError.message,
        };
    } finally {
        loading.value = false;
    }
}

// 供应商直连测试：POST /vendor/:id/test.json，测试用户选中的供应商模型
async function runVendorTest() {
    if (!currentVendor.value || !testModel.value) return;

    const model = testModel.value;
    loading.value = true;
    result.value = null;
    try {
        const res = await testVendor(currentVendor.value.id, format.value, model);
        result.value = res;
        if (res.success) {
            notifySuccess('测试完成，连接正常');
        } else {
            if (res.status) {
                notifyWarning(`测试完成，但上游返回错误 (HTTP ${res.status})`);
            } else {
                notifyWarning(`测试请求失败 (底层网络报错)`);
            }
        }
    } catch (error) {
        const requestError = notifyRequestError(error, '测试请求发送失败');
        result.value = {
            success: false,
            error: requestError.message,
        };
    } finally {
        loading.value = false;
    }
}

async function handleTest() {
    if (isModelMode.value) {
        await runRoutingTest();
    } else {
        await runVendorTest();
    }
}

defineExpose({ openVendorTest, openModelTest });
</script>

<style scoped>
.test-dialog {
    padding: 8px 0;
}

.test-config {
    margin-bottom: 16px;
}

.hint-text {
    font-size: 12px;
    color: #8c8c8c;
    margin-top: 4px;
}

.model-info {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 16px;
    padding: 10px 12px;
    background: #f5f5f5;
    border-radius: 6px;
}

.info-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 13px;
}

.info-label {
    color: #8c8c8c;
    white-space: nowrap;
    flex-shrink: 0;
}

.info-label::after {
    content: '：';
}

.info-value {
    color: #262626;
    word-break: break-all;
}

.test-result {
    margin-top: 24px;
}

.result-summary {
    margin-bottom: 16px;
    padding: 12px;
    background: #f6f8fa;
    border-radius: 4px;
}

.status-text {
    font-weight: bold;
}

.status-text.success {
    color: #52c41a;
}

.status-text.error {
    color: #ff4d4f;
}

.status-code, .duration {
    color: #8c8c8c;
    font-size: 13px;
    margin-left: 8px;
}

.auto-convert-row {
    margin-bottom: 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.auto-convert-main {
    display: flex;
    align-items: center;
    gap: 8px;
}

.convert-hint {
    color: #8c8c8c;
    font-size: 12px;
}

.convert-reason-line {
    margin-left: 24px;
    color: #faad14;
    font-size: 12px;
    line-height: 1.4;
}

.no-url-hint {
    color: #ff4d4f;
    font-size: 12px;
}

.result-convert {
    margin-top: 4px;
    font-size: 12px;
    background: #f0f2f5;
    padding: 4px 8px;
    border-radius: 4px;
}

.convert-label {
    color: #8c8c8c;
    margin-right: 8px;
    font-weight: 500;
}

.convert-text {
    color: #1677ff;
    font-family: monospace;
}

.result-url {
    margin-top: 4px;
    font-size: 12px;
    word-break: break-all;
    background: #f0f2f5;
    padding: 4px 8px;
    border-radius: 4px;
}

.url-label {
    color: #8c8c8c;
    margin-right: 8px;
    font-weight: 500;
}

.url-text {
    color: #595959;
    font-family: monospace;
}

.result-proxy {
    margin-top: 4px;
    font-size: 12px;
    word-break: break-all;
    background: #f0f2f5;
    padding: 4px 8px;
    border-radius: 4px;
}

.proxy-label {
    color: #8c8c8c;
    margin-right: 8px;
    font-weight: 500;
}

.proxy-text {
    color: #1677ff;
    font-family: monospace;
}

.result-detail {
    margin-top: 16px;
}

.detail-label {
    font-size: 13px;
    color: #8c8c8c;
    margin-bottom: 8px;
}

.response-body {
    background: #282c34;
    color: #abb2bf;
    padding: 12px;
    border-radius: 4px;
    font-size: 12px;
    max-height: 300px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
}

.request-body {
    background: #1e222a;
    color: #abb2bf;
    padding: 12px;
    border-radius: 4px;
    font-size: 12px;
    max-height: 300px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
}

.tab-action {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 8px;
}

.copy-btn {
    padding: 0;
    height: auto;
    font-size: 12px;
}

.response-body::-webkit-scrollbar,
.request-body::-webkit-scrollbar {
    width: 8px;
    height: 8px;
}

.response-body::-webkit-scrollbar-track,
.request-body::-webkit-scrollbar-track {
    background: rgba(255, 255, 255, 0.02);
    border-radius: 4px;
}

.response-body::-webkit-scrollbar-thumb,
.request-body::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.2);
    border-radius: 4px;
}

.response-body::-webkit-scrollbar-thumb:hover,
.request-body::-webkit-scrollbar-thumb:hover {
    background: rgba(255, 255, 255, 0.3);
}

.response-body,
.request-body {
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 255, 255, 0.2) rgba(255, 255, 255, 0.02);
}
</style>
