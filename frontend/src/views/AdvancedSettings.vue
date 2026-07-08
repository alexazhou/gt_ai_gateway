<template>
    <div class="advanced-settings">
        <div class="page-header">
            <h2 class="page-title">高级设置</h2>
        </div>

        <a-spin :spinning="loading">
            <div class="settings-section">
                <h3 class="section-title">请求处理</h3>
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
            </div>

            <div class="settings-section">
                <h3 class="section-title">调试与日志</h3>
                <div class="settings-list">
                    <div class="setting-item">
                        <div class="setting-info">
                            <div class="setting-title">记录请求/响应内容</div>
                            <div class="setting-desc">启用后，每次请求的 request/response 原始内容会写入对象存储（Node 模式存数据库表，Worker 模式存 R2），可在请求记录详情中查看。关闭可节省存储空间，但新记录的详情将不再包含请求/响应内容（已保存的历史记录不受影响）。</div>
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
            </div>

            <div class="settings-section">
                <h3 class="section-title">系统</h3>
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
            </div>

            <div class="page-actions">
                <a-button style="margin-right: 12px" :disabled="!isDirty || saving" @click="cancelChanges">
                    取消修改
                </a-button>
                <a-button type="primary" :loading="saving" :disabled="!isDirty" @click="saveConfig">
                    保存配置
                </a-button>
            </div>
        </a-spin>
    </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref, computed } from 'vue';
import { message } from 'ant-design-vue/es';
import { getConfig, updateConfig } from '@/api/config';
import { checkUpdate } from '@/api/system';
import { useAppStore } from '@/stores/app';
import { RunMode } from '@/types/system';

const appStore = useAppStore();
const currentVersion = computed(() => appStore.version);
// Cloudflare Workers 模式下无法写本地日志文件，隐藏流式日志开关
const isWorkerMode = computed(() => appStore.mode === RunMode.WORKER);
const checkingUpdate = ref(false);
const checkedUpdate = ref(false);
const hasUpdate = ref(false);
const updateUrl = ref('');
const latestVersion = ref('');

const loading = ref(false);
const saving = ref(false);

const originalConfig = reactive({
    cch_rewrite_enabled: false,
    responses_prompt_cache_key_enabled: false,
    claude_code_tracking_rewrite_enabled: true,
    stream_log_enabled: false,
    record_payload_enabled: true,
    auto_update_enabled: true,
    telemetry_disabled: false,
});

const form = reactive({
    cch_rewrite_enabled: false,
    responses_prompt_cache_key_enabled: false,
    claude_code_tracking_rewrite_enabled: true,
    stream_log_enabled: false,
    record_payload_enabled: true,
    auto_update_enabled: true,
    telemetry_disabled: false,
});

const isDirty = computed(() => {
    return form.cch_rewrite_enabled !== originalConfig.cch_rewrite_enabled ||
           form.responses_prompt_cache_key_enabled !== originalConfig.responses_prompt_cache_key_enabled ||
           form.claude_code_tracking_rewrite_enabled !== originalConfig.claude_code_tracking_rewrite_enabled ||
           form.stream_log_enabled !== originalConfig.stream_log_enabled ||
           form.record_payload_enabled !== originalConfig.record_payload_enabled ||
           form.auto_update_enabled !== originalConfig.auto_update_enabled ||
           form.telemetry_disabled !== originalConfig.telemetry_disabled;
});

onMounted(() => {
    void loadConfig();
});

async function loadConfig(): Promise<void> {
    loading.value = true;
    try {
        const config = await getConfig();
        form.cch_rewrite_enabled = config.cch_rewrite_enabled !== "false";
        originalConfig.cch_rewrite_enabled = config.cch_rewrite_enabled !== "false";
        
        form.responses_prompt_cache_key_enabled = config.responses_prompt_cache_key_enabled !== "false";
        originalConfig.responses_prompt_cache_key_enabled = config.responses_prompt_cache_key_enabled !== "false";
        
        form.claude_code_tracking_rewrite_enabled = config.claude_code_tracking_rewrite_enabled !== "false"; // Default to true
        originalConfig.claude_code_tracking_rewrite_enabled = config.claude_code_tracking_rewrite_enabled !== "false";

        form.stream_log_enabled = config.stream_log_enabled === "true";
        originalConfig.stream_log_enabled = config.stream_log_enabled === "true";

        form.record_payload_enabled = config.record_payload_enabled !== "false";
        originalConfig.record_payload_enabled = config.record_payload_enabled !== "false";

        form.auto_update_enabled = config.auto_update_enabled !== "false";
        originalConfig.auto_update_enabled = config.auto_update_enabled !== "false";

        form.telemetry_disabled = config.telemetry_disabled === "true";
        originalConfig.telemetry_disabled = config.telemetry_disabled === "true";
        // 始终拉取一次 status，确保 mode（用于判断是否 worker 模式）是最新的
        await appStore.fetchVersion();
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
    form.auto_update_enabled = originalConfig.auto_update_enabled;
    form.telemetry_disabled = originalConfig.telemetry_disabled;
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

async function saveConfig() {
    saving.value = true;
    try {
        await updateConfig({
            cch_rewrite_enabled: form.cch_rewrite_enabled ? "true" : "false",
            responses_prompt_cache_key_enabled: form.responses_prompt_cache_key_enabled ? "true" : "false",
            claude_code_tracking_rewrite_enabled: form.claude_code_tracking_rewrite_enabled ? "true" : "false",
            stream_log_enabled: form.stream_log_enabled ? "true" : "false",
            record_payload_enabled: form.record_payload_enabled ? "true" : "false",
            auto_update_enabled: form.auto_update_enabled ? "true" : "false",
            telemetry_disabled: form.telemetry_disabled ? "true" : "false",
        });
        message.success('配置已保存');
        originalConfig.cch_rewrite_enabled = form.cch_rewrite_enabled;
        originalConfig.responses_prompt_cache_key_enabled = form.responses_prompt_cache_key_enabled;
        originalConfig.claude_code_tracking_rewrite_enabled = form.claude_code_tracking_rewrite_enabled;
        originalConfig.stream_log_enabled = form.stream_log_enabled;
        originalConfig.record_payload_enabled = form.record_payload_enabled;
        originalConfig.auto_update_enabled = form.auto_update_enabled;
        originalConfig.telemetry_disabled = form.telemetry_disabled;
        
        // Update posthog capturing state immediately in the current tab
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

.settings-section {
    margin-bottom: 32px;
}

.section-title {
    margin: 0 0 16px;
    font-size: 16px;
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
</style>
