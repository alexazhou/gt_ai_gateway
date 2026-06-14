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
                                v-model:checked="form.cch_rewrite_enabled"
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

const loading = ref(false);
const saving = ref(false);

const originalConfig = reactive({
    cch_rewrite_enabled: false,
});

const form = reactive({
    cch_rewrite_enabled: false,
});

const isDirty = computed(() => {
    return form.cch_rewrite_enabled !== originalConfig.cch_rewrite_enabled;
});

onMounted(() => {
    void loadConfig();
});

async function loadConfig(): Promise<void> {
    loading.value = true;
    try {
        const config = await getConfig();
        form.cch_rewrite_enabled = config.cch_rewrite_enabled === true;
        originalConfig.cch_rewrite_enabled = config.cch_rewrite_enabled === true;
    } finally {
        loading.value = false;
    }
}

function cancelChanges() {
    form.cch_rewrite_enabled = originalConfig.cch_rewrite_enabled;
}

async function saveConfig(): Promise<void> {
    saving.value = true;
    try {
        const config = await updateConfig({
            cch_rewrite_enabled: form.cch_rewrite_enabled,
        });
        form.cch_rewrite_enabled = config.cch_rewrite_enabled === true;
        originalConfig.cch_rewrite_enabled = config.cch_rewrite_enabled === true;
        message.success('设置已保存');
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
