<template>
    <div class="developer-settings">
        <div class="page-header">
            <h2 class="page-title">开发者设置</h2>
        </div>

        <a-spin :spinning="loading">
            <div class="settings-section">
                <h3 class="section-title">系统信息</h3>
                <div class="settings-list">
                    <div class="setting-item">
                        <div class="setting-info">
                            <div class="setting-title">本机唯一 ID (Host Key)</div>
                            <div class="setting-desc">用于区分不同实例的短标识，不可随意修改。如需重新生成，可清空后保存。</div>
                        </div>
                        <div class="setting-action">
                            <a-input
                                v-model:value="form.host_key"
                                style="width: 200px"
                                placeholder="留空自动生成"
                                :disabled="saving"
                            />
                        </div>
                    </div>
                </div>
            </div>

            <div class="settings-section">
                <h3 class="section-title">多租户</h3>
                <div class="settings-list">
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
            </div>

            <div class="page-actions">
                <a-button style="margin-right: 12px" :disabled="!isDirty || saving" @click="cancelChanges">
                    取消修改
                </a-button>
                <a-button type="primary" :loading="saving" :disabled="!isDirty" @click="saveConfig">
                    保存配置
                </a-button>
            </div>
            
            <div style="margin-top: 24px; display: flex; justify-content: flex-end;">
                <a-button type="link" style="color: var(--text-secondary, #8c8c8c)" @click="exitDeveloperMode">
                    关闭开发者选项并退出
                </a-button>
            </div>
        </a-spin>
    </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { message } from 'ant-design-vue/es';
import { getConfig, updateConfig } from '@/api/config';
import { useAppStore } from '@/stores/app';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const appStore = useAppStore();
const authStore = useAuthStore();
const loading = ref(false);
const saving = ref(false);

const isRoot = computed(() => authStore.userType === 'root');

const originalConfig = reactive({
    host_key: '',
    multi_tenant_enabled: false,
});

const form = reactive({
    host_key: '',
    multi_tenant_enabled: false,
});

const isDirty = computed(() => {
    return form.host_key !== originalConfig.host_key ||
           form.multi_tenant_enabled !== originalConfig.multi_tenant_enabled;
});

onMounted(() => {
    void loadConfig();
});

async function loadConfig(): Promise<void> {
    loading.value = true;
    try {
        const config = await getConfig();
        form.host_key = config.host_key || '';
        originalConfig.host_key = config.host_key || '';
        form.multi_tenant_enabled = config.multi_tenant_enabled === "true";
        originalConfig.multi_tenant_enabled = config.multi_tenant_enabled === "true";
    } finally {
        loading.value = false;
    }
}

function cancelChanges() {
    form.host_key = originalConfig.host_key;
    form.multi_tenant_enabled = originalConfig.multi_tenant_enabled;
}

async function saveConfig(): Promise<void> {
    saving.value = true;
    try {
        const config = await updateConfig({
            ...(form.host_key ? { host_key: form.host_key } : {}),
            multi_tenant_enabled: form.multi_tenant_enabled ? "true" : "false",
        });

        form.host_key = config.host_key || '';
        originalConfig.host_key = config.host_key || '';
        originalConfig.multi_tenant_enabled = form.multi_tenant_enabled;

        // 多租户开关变化后刷新 /status.json（tenant.multi_tenant_enabled / main_id）
        await appStore.fetchStatus();

        message.success('设置已保存');
    } catch {
        // error handling is typically done by the request interceptor
    } finally {
        saving.value = false;
    }
}

function exitDeveloperMode() {
    appStore.disableDeveloperMode();
    message.success('已退出开发者模式');
    router.push('/dashboard');
}
</script>

<style scoped>
.developer-settings {
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
    background: var(--bg-card, #ffffff);
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
