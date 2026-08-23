<template>
    <div class="advanced-settings">
        <div class="page-header">
            <h2 class="page-title">设置</h2>
        </div>

        <a-spin :spinning="loading">
            <a-tabs v-model:activeKey="activeTab">
                <!-- 功能模块 -->
                <a-tab-pane key="modules" tab="功能模块">
                    <div class="settings-list">
                        <div class="setting-item">
                            <div class="setting-info">
                                <div class="setting-title">模型计费</div>
                                <div class="setting-desc">启用后，可在模型管理中设置计费价格，并使用余额管理功能对用户进行计费</div>
                            </div>
                            <div class="setting-action">
                                <a-switch
                                    :checked="form.module_billing_enabled"
                                    @change="form.module_billing_enabled = $event as boolean"
                                    :disabled="saving"
                                />
                            </div>
                        </div>
                        <div class="setting-item">
                            <div class="setting-info">
                                <div class="setting-title">API 体验</div>
                                <div class="setting-desc">启用后，侧边栏将显示 API 体验入口，可在线调试和测试接口</div>
                            </div>
                            <div class="setting-action">
                                <a-switch
                                    :checked="form.module_api_playground_enabled"
                                    @change="form.module_api_playground_enabled = $event as boolean"
                                    :disabled="saving"
                                />
                            </div>
                        </div>
                        <div class="setting-item">
                            <div class="setting-info">
                                <div class="setting-title">客户端管理</div>
                                <div class="setting-desc">启用后，侧边栏将显示客户端管理入口，可管理各客户端的连接配置</div>
                            </div>
                            <div class="setting-action">
                                <a-switch
                                    :checked="form.module_client_config_enabled"
                                    @change="form.module_client_config_enabled = $event as boolean"
                                    :disabled="saving"
                                />
                            </div>
                        </div>
                        <div class="setting-item">
                            <div class="setting-info">
                                <div class="setting-title">多租户隔离</div>
                                <div class="setting-desc">启用后按租户隔离用户/模型/供应商；关闭时退回逻辑单租户（仅 main），仅 root 可修改</div>
                            </div>
                            <div class="setting-action">
                                <a-switch
                                    :checked="form.multi_tenant_enabled"
                                    @change="form.multi_tenant_enabled = $event as boolean"
                                    :disabled="saving || !isRoot"
                                />
                            </div>
                        </div>
                    </div>
                </a-tab-pane>

                <!-- 请求处理 -->
                <a-tab-pane key="request" tab="请求处理">
                    <div class="settings-list">
                        <div class="setting-item">
                            <div class="setting-info">
                                <div class="setting-title">强制改写 CCH</div>
                                <div class="setting-desc">启用后，系统会自动修改 claudecode 请求体中的 cch 值为默认固定值，用于修复无法命中缓存问题</div>
                            </div>
                            <div class="setting-action">
                                <a-switch
                                    :checked="form.cch_rewrite_enabled"
                                    @change="form.cch_rewrite_enabled = $event as boolean"
                                    :disabled="saving"
                                />
                            </div>
                        </div>
                        <div class="setting-item">
                            <div class="setting-info">
                                <div class="setting-title">屏蔽 Claude Code 跟踪</div>
                                <div class="setting-desc">启用后，系统会自动清洗 Claude Code 发送的隐藏的地区/时区/公司跟踪标记，避免污染用户真实数据与缓存特征</div>
                            </div>
                            <div class="setting-action">
                                <a-switch
                                    :checked="form.claude_code_tracking_rewrite_enabled"
                                    @change="form.claude_code_tracking_rewrite_enabled = $event as boolean"
                                    :disabled="saving"
                                />
                            </div>
                        </div>
                        <div class="setting-item">
                            <div class="setting-info">
                                <div class="setting-title">Responses API 粘性路由</div>
                                <div class="setting-desc">启用后，会在 Responses API 请求中自动注入 prompt_cache_key，优化缓存命中率</div>
                            </div>
                            <div class="setting-action">
                                <a-switch
                                    :checked="form.responses_prompt_cache_key_enabled"
                                    @change="form.responses_prompt_cache_key_enabled = $event as boolean"
                                    :disabled="saving"
                                />
                            </div>
                        </div>
                    </div>
                </a-tab-pane>

                <!-- 日志 -->
                <a-tab-pane key="logging" tab="分析和录制">
                    <div class="settings-list">
                        <div class="setting-item">
                            <div class="setting-info">
                                <div class="setting-title">记录请求/响应内容</div>
                                <div class="setting-desc">启用后，每次请求的请求内容和响应内容会被存储，并可在请求记录详情中查看。关闭可节省存储空间，但新记录的详情将不再包含请求/响应内容（已保存的历史记录不受影响）。</div>
                            </div>
                            <div class="setting-action">
                                <a-switch
                                    :checked="form.record_payload_enabled"
                                    @change="form.record_payload_enabled = $event as boolean"
                                    :disabled="saving"
                                />
                            </div>
                        </div>
                        <div class="setting-item" v-if="!isWorkerMode">
                            <div class="setting-info">
                                <div class="setting-title">流式日志记录</div>
                                <div class="setting-desc">启用后，会将上游返回的原始 SSE 流式响应写入 log/stream/&lt;record_id&gt;.log，仅本地 Node 模式下生效，用于抓取原始流式请求</div>
                            </div>
                            <div class="setting-action">
                                <a-switch
                                    :checked="form.stream_log_enabled"
                                    @change="form.stream_log_enabled = $event as boolean"
                                    :disabled="saving"
                                />
                            </div>
                        </div>
                    </div>

                    <div class="settings-section" style="margin-top: 24px;">
                        <h3 class="section-title">数据存储</h3>
                        <div class="settings-list">
                            <div class="setting-item">
                                <div class="setting-info">
                                    <div class="setting-title">数据存储位置</div>
                                    <div class="setting-desc">存储记录的请求/响应内容的位置</div>
                                </div>
                                <div class="setting-action">
                                    <a-select
                                        v-model:value="form.record_payload_storage"
                                        class="storage-select"
                                        option-label-prop="label"
                                        :dropdown-match-select-width="320"
                                        :disabled="saving"
                                    >
                                        <a-select-option value="auto" label="自动">
                                            <div class="storage-option">
                                                <div class="storage-option-title">自动</div>
                                                <div class="storage-option-desc">非 Cloudflare 环境优先数据库，Cloudflare 环境优先 R2</div>
                                            </div>
                                        </a-select-option>
                                        <a-select-option value="database" label="数据库">
                                            <div class="storage-option">
                                                <div class="storage-option-title">数据库</div>
                                                <div class="storage-option-desc">将请求和响应内容存储到数据库</div>
                                            </div>
                                        </a-select-option>
                                        <a-select-option value="r2" label="R2" :disabled="!isR2StorageAvailable">
                                            <div class="storage-option">
                                                <div class="storage-option-title">R2</div>
                                                <div class="storage-option-desc">
                                                    <span>将请求和响应内容存储到 Cloudflare R2</span>
                                                    <span v-if="r2StorageUnavailableReason" class="storage-option-reason">
                                                        {{ r2StorageUnavailableReason }}
                                                    </span>
                                                </div>
                                            </div>
                                        </a-select-option>
                                    </a-select>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="settings-section" style="margin-top: 24px;">
                        <h3 class="section-title">数据清理</h3>
                        <div class="settings-list">
                            <div class="setting-item">
                                <div class="setting-info">
                                    <div class="setting-title">删除请求数据</div>
                                    <div class="setting-desc">清理历史请求记录，释放存储空间</div>
                                </div>
                                <div class="setting-action">
                                    <a-button danger @click="showDeleteModal">
                                        删除数据
                                    </a-button>
                                </div>
                            </div>
                        </div>
                    </div>
                </a-tab-pane>

                <!-- 系统 -->
                <a-tab-pane key="system" tab="系统">
                    <div class="settings-list">
                        <div class="setting-item">
                            <div class="setting-info">
                                <div class="setting-title">自动检测更新</div>
                                <div class="setting-desc">
                                    当前版本：v{{ currentVersion }}
                                    <span v-if="hasUpdate" style="color: var(--accent-primary); margin-left: 8px;">
                                        (发现新版本：{{ latestVersion }})
                                    </span>
                                    <span v-else-if="checkedUpdate" style="color: var(--text-secondary); margin-left: 8px;">
                                        (已是最新版本)
                                    </span>
                                </div>
                            </div>
                            <div class="setting-action" style="display: flex; align-items: center; gap: 16px;">
                                <a-button
                                    v-if="hasUpdate"
                                    type="primary"
                                    @click="openUpdateUrl"
                                >
                                    下载更新
                                </a-button>
                                <a-button v-else :loading="checkingUpdate" @click="doCheckUpdate">
                                    检查更新
                                </a-button>
                                <a-switch
                                    :checked="form.auto_update_enabled"
                                    @change="form.auto_update_enabled = $event as boolean"
                                    :disabled="saving"
                                />
                            </div>
                        </div>
                        <div class="setting-item">
                            <div class="setting-info">
                                <div class="setting-title">退出用户体验改进计划</div>
                                <div class="setting-desc">开启后，将彻底关闭和开发者共享数据来帮助改进产品。</div>
                            </div>
                            <div class="setting-action">
                                <a-switch
                                    :checked="form.telemetry_disabled"
                                    @change="form.telemetry_disabled = $event as boolean"
                                    :disabled="saving"
                                />
                            </div>
                        </div>
                    </div>
                </a-tab-pane>
            </a-tabs>

            <div class="page-actions">
                <a-button style="margin-right: 12px" :disabled="!isDirty || saving" @click="cancelChanges">
                    取消修改
                </a-button>
                <a-button type="primary" :loading="saving" :disabled="!isDirty" @click="saveConfig">
                    保存配置
                </a-button>
            </div>
        </a-spin>

        <!-- 删除数据弹窗 -->
        <a-modal
            v-model:open="deleteModalVisible"
            title="删除请求数据"
            :confirm-loading="deleting"
            @ok="handleDeleteConfirm"
        >
            <a-radio-group v-model:value="deleteMode" style="display: flex; flex-direction: column; gap: 12px;">
                <a-radio value="payload">
                    <div>
                        <div style="font-weight: 500;">删除请求体</div>
                        <div style="font-size: 12px; color: #8c8c8c;">保留请求记录元数据（时间、模型、Token 等），仅清除 request/response 原始内容</div>
                    </div>
                </a-radio>
                <a-radio value="all">
                    <div>
                        <div style="font-weight: 500;">删除完整请求记录</div>
                        <div style="font-size: 12px; color: #8c8c8c;">彻底删除所有请求记录，此操作不可恢复</div>
                    </div>
                </a-radio>
            </a-radio-group>
        </a-modal>
    </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref, computed } from 'vue';
import { message } from 'ant-design-vue/es';
import { getConfig, updateConfig } from '@/api/config';
import { checkUpdate } from '@/api/system';
import { clearPayload, clearAllRecords } from '@/api/record';
import { useAppStore } from '@/stores/app';
import { useAuthStore } from '@/stores/auth';
import { RunMode } from '@/types/system';

const appStore = useAppStore();
const authStore = useAuthStore();

const isRoot = computed(() => authStore.userType === 'root');
const currentVersion = computed(() => appStore.version);
const isWorkerMode = computed(() => appStore.mode === RunMode.WORKER);
const isR2StorageAvailable = computed(() => appStore.r2StorageAvailable);
const r2StorageUnavailableReason = computed(() => (
    !isR2StorageAvailable.value ? appStore.r2StorageUnavailableReason : ''
));
const checkingUpdate = ref(false);
const checkedUpdate = ref(false);
const hasUpdate = ref(false);
const updateUrl = ref('');
const latestVersion = ref('');

const loading = ref(false);
const saving = ref(false);
const activeTab = ref('modules');

const deleteModalVisible = ref(false);
const deleteMode = ref<'payload' | 'all'>('payload');
const deleting = ref(false);
type RecordPayloadStorage = 'auto' | 'database' | 'r2';

const originalConfig = reactive({
    cch_rewrite_enabled: false,
    responses_prompt_cache_key_enabled: false,
    claude_code_tracking_rewrite_enabled: true,
    stream_log_enabled: false,
    record_payload_enabled: true,
    record_payload_storage: 'auto' as RecordPayloadStorage,
    auto_update_enabled: true,
    telemetry_disabled: false,
    module_billing_enabled: false,
    module_api_playground_enabled: false,
    module_client_config_enabled: false,
    multi_tenant_enabled: false,
});

const form = reactive({
    cch_rewrite_enabled: false,
    responses_prompt_cache_key_enabled: false,
    claude_code_tracking_rewrite_enabled: true,
    stream_log_enabled: false,
    record_payload_enabled: true,
    record_payload_storage: 'auto' as RecordPayloadStorage,
    auto_update_enabled: true,
    telemetry_disabled: false,
    module_billing_enabled: false,
    module_api_playground_enabled: false,
    module_client_config_enabled: false,
    multi_tenant_enabled: false,
});

const isDirty = computed(() => {
    return form.cch_rewrite_enabled !== originalConfig.cch_rewrite_enabled ||
           form.responses_prompt_cache_key_enabled !== originalConfig.responses_prompt_cache_key_enabled ||
           form.claude_code_tracking_rewrite_enabled !== originalConfig.claude_code_tracking_rewrite_enabled ||
           form.stream_log_enabled !== originalConfig.stream_log_enabled ||
           form.record_payload_enabled !== originalConfig.record_payload_enabled ||
           form.record_payload_storage !== originalConfig.record_payload_storage ||
           form.auto_update_enabled !== originalConfig.auto_update_enabled ||
           form.telemetry_disabled !== originalConfig.telemetry_disabled ||
           form.module_billing_enabled !== originalConfig.module_billing_enabled ||
           form.module_api_playground_enabled !== originalConfig.module_api_playground_enabled ||
           form.module_client_config_enabled !== originalConfig.module_client_config_enabled ||
           form.multi_tenant_enabled !== originalConfig.multi_tenant_enabled;
});

onMounted(() => {
    void loadConfig();
});

function normalizeRecordPayloadStorage(value: string | undefined): RecordPayloadStorage {
    if (value === 'auto' || value === 'database' || value === 'r2') {
        return value;
    }

    return 'auto';
}

async function loadConfig(): Promise<void> {
    loading.value = true;
    try {
        const config = await getConfig();
        await appStore.fetchStatus();

        form.cch_rewrite_enabled = config.cch_rewrite_enabled !== "false";
        originalConfig.cch_rewrite_enabled = config.cch_rewrite_enabled !== "false";

        form.responses_prompt_cache_key_enabled = config.responses_prompt_cache_key_enabled !== "false";
        originalConfig.responses_prompt_cache_key_enabled = config.responses_prompt_cache_key_enabled !== "false";

        form.claude_code_tracking_rewrite_enabled = config.claude_code_tracking_rewrite_enabled !== "false";
        originalConfig.claude_code_tracking_rewrite_enabled = config.claude_code_tracking_rewrite_enabled !== "false";

        form.stream_log_enabled = config.stream_log_enabled === "true";
        originalConfig.stream_log_enabled = config.stream_log_enabled === "true";

        form.record_payload_enabled = config.record_payload_enabled !== "false";
        originalConfig.record_payload_enabled = config.record_payload_enabled !== "false";

        form.record_payload_storage = normalizeRecordPayloadStorage(config.record_payload_storage);
        originalConfig.record_payload_storage = form.record_payload_storage;

        form.auto_update_enabled = config.auto_update_enabled !== "false";
        originalConfig.auto_update_enabled = config.auto_update_enabled !== "false";

        form.telemetry_disabled = config.telemetry_disabled === "true";
        originalConfig.telemetry_disabled = config.telemetry_disabled === "true";

        form.module_billing_enabled = config.module_billing_enabled === "true";
        originalConfig.module_billing_enabled = config.module_billing_enabled === "true";

        form.module_api_playground_enabled = config.module_api_playground_enabled === "true";
        originalConfig.module_api_playground_enabled = config.module_api_playground_enabled === "true";

        form.module_client_config_enabled = config.module_client_config_enabled === "true";
        originalConfig.module_client_config_enabled = config.module_client_config_enabled === "true";

        form.multi_tenant_enabled = config.multi_tenant_enabled === "true";
        originalConfig.multi_tenant_enabled = config.multi_tenant_enabled === "true";
    } finally {
        loading.value = false;
    }
}

function cancelChanges() {
    form.cch_rewrite_enabled = originalConfig.cch_rewrite_enabled;
    form.responses_prompt_cache_key_enabled = originalConfig.responses_prompt_cache_key_enabled;
    form.claude_code_tracking_rewrite_enabled = originalConfig.claude_code_tracking_rewrite_enabled;
    form.stream_log_enabled = originalConfig.stream_log_enabled;
    form.record_payload_enabled = originalConfig.record_payload_enabled;
    form.record_payload_storage = originalConfig.record_payload_storage;
    form.auto_update_enabled = originalConfig.auto_update_enabled;
    form.telemetry_disabled = originalConfig.telemetry_disabled;
    form.module_billing_enabled = originalConfig.module_billing_enabled;
    form.module_api_playground_enabled = originalConfig.module_api_playground_enabled;
    form.module_client_config_enabled = originalConfig.module_client_config_enabled;
}

async function doCheckUpdate() {
    checkingUpdate.value = true;
    try {
        const status = await checkUpdate(true);
        if (!status.success) {
            message.error(status.error_message || '检查更新失败');
            return;
        }

        hasUpdate.value = status.has_update;
        checkedUpdate.value = true;
        if (status.has_update) {
            updateUrl.value = status.release_url || '';
            latestVersion.value = status.latest_version;
            message.info(`发现新版本 v${status.latest_version}`);
        } else {
            message.success('当前已是最新版本');
        }
    } catch (e) {
        message.error('检查更新失败');
        console.error(e);
    } finally {
        checkingUpdate.value = false;
    }
}

import { openUrl } from '@/utils/platform';

async function openUpdateUrl() {
    await openUrl(updateUrl.value);
}

function showDeleteModal() {
    deleteMode.value = 'payload';
    deleteModalVisible.value = true;
}

async function handleDeleteConfirm() {
    deleting.value = true;
    try {
        if (deleteMode.value === 'payload') {
            const res = await clearPayload();
            message.success(`已清除 ${res.cleared} 条记录的请求体`);
        } else {
            const res = await clearAllRecords();
            message.success(`已删除 ${res.deleted} 条请求记录`);
        }
        deleteModalVisible.value = false;
    } catch {
        message.error('删除失败');
    } finally {
        deleting.value = false;
    }
}

async function saveConfig() {
    saving.value = true;
    try {
        await updateConfig({
            cch_rewrite_enabled: form.cch_rewrite_enabled ? "true" : "false",
            responses_prompt_cache_key_enabled: form.responses_prompt_cache_key_enabled ? "true" : "false",
            claude_code_tracking_rewrite_enabled: form.claude_code_tracking_rewrite_enabled ? "true" : "false",
            stream_log_enabled: form.stream_log_enabled ? "true" : "false",
            record_payload_enabled: form.record_payload_enabled ? "true" : "false",
            record_payload_storage: form.record_payload_storage,
            auto_update_enabled: form.auto_update_enabled ? "true" : "false",
            telemetry_disabled: form.telemetry_disabled ? "true" : "false",
            module_billing_enabled: form.module_billing_enabled ? "true" : "false",
            module_api_playground_enabled: form.module_api_playground_enabled ? "true" : "false",
            module_client_config_enabled: form.module_client_config_enabled ? "true" : "false",
            multi_tenant_enabled: form.multi_tenant_enabled ? "true" : "false",
        });
        message.success('配置已保存');
        originalConfig.cch_rewrite_enabled = form.cch_rewrite_enabled;
        originalConfig.responses_prompt_cache_key_enabled = form.responses_prompt_cache_key_enabled;
        originalConfig.claude_code_tracking_rewrite_enabled = form.claude_code_tracking_rewrite_enabled;
        originalConfig.stream_log_enabled = form.stream_log_enabled;
        originalConfig.record_payload_enabled = form.record_payload_enabled;
        originalConfig.record_payload_storage = form.record_payload_storage;
        originalConfig.auto_update_enabled = form.auto_update_enabled;
        originalConfig.telemetry_disabled = form.telemetry_disabled;
        originalConfig.module_billing_enabled = form.module_billing_enabled;
        originalConfig.module_api_playground_enabled = form.module_api_playground_enabled;
        originalConfig.module_client_config_enabled = form.module_client_config_enabled;
        originalConfig.multi_tenant_enabled = form.multi_tenant_enabled;

        // 同步全局状态
        appStore.moduleBillingEnabled = form.module_billing_enabled;
        appStore.moduleApiPlaygroundEnabled = form.module_api_playground_enabled;
        appStore.moduleClientConfigEnabled = form.module_client_config_enabled;

        // 多租户开关变化后刷新 /status.json（tenant.multi_tenant_enabled / main_id）
        await appStore.fetchStatus();

        if ((window as any).posthog) {
            if (form.telemetry_disabled) {
                (window as any).posthog.opt_out_capturing();
            } else {
                (window as any).posthog.opt_in_capturing();
            }
        }
    } catch {
        // error handling is typically done by the request interceptor
    } finally {
        saving.value = false;
    }
}
</script>

<style scoped>
.advanced-settings {
    background: var(--bg-page);
    min-height: calc(100vh - 64px);
    padding: 24px;
    max-width: 900px;
}

.page-header {
    margin-bottom: 24px;
}

.page-title {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
    color: var(--text-primary);
}

.settings-list {
    background: var(--component-bg, #ffffff);
    border: 1px solid var(--border-color, #f0f0f0);
    border-radius: 8px;
    overflow: hidden;
}

.setting-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 20px 24px;
    transition: background-color 0.3s;
}

.setting-item:not(:last-child) {
    border-bottom: 1px solid var(--border-color, #f0f0f0);
}

.setting-info {
    flex: 1;
    min-width: 0;
    margin-right: 24px;
}

.setting-title {
    color: var(--text-primary);
    font-size: 15px;
    font-weight: 500;
    margin-bottom: 4px;
}

.setting-desc {
    color: var(--text-secondary, #8c8c8c);
    font-size: 13px;
    line-height: 1.5;
}

.page-actions {
    margin-top: 24px;
    display: flex;
    justify-content: flex-end;
}

.storage-select {
    width: 120px;
}

:deep(.ant-select-item-option-content) {
    white-space: normal;
}

.storage-option {
    width: 280px;
    padding: 2px 0;
}

.storage-option-title {
    color: var(--text-primary);
    font-size: 14px;
    font-weight: 500;
    line-height: 20px;
}

.storage-option-desc {
    color: var(--text-secondary, #8c8c8c);
    font-size: 12px;
    line-height: 18px;
    white-space: normal;
    overflow-wrap: anywhere;
}

.storage-option-reason {
    display: block;
    margin-top: 2px;
    color: var(--error-color, #ff4d4f);
}

:deep(.ant-tabs-tab) {
    font-size: 15px;
    font-weight: 500;
}
</style>
