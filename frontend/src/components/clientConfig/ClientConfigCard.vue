<template>
    <div
        class="config-row saved-config-row"
        :class="{ 'active-config-row': backup.enabled }"
    >
        <div class="icon-placeholder" style="display: flex; align-items: center; justify-content: center;" v-if="isRestoring">
            <a-spin size="small" />
        </div>
        <button
            v-else-if="backup.enabled"
            type="button"
            class="check-state-button checked-check-button"
            disabled
            aria-label="当前启用配置"
        >
            <CheckCircleFilled class="current-config-icon" />
        </button>
        <button
            v-else
            type="button"
            class="check-state-button empty-check-circle"
            aria-label="启用该配置"
            @click="$emit('applyConfig', backup.id)"
        ></button>
        
        <div class="config-row-content">
            <div class="config-row-name config-row-name-with-action">
                <span>{{ backup.name }}</span>

                <a-tag
                    v-if="backup.enabled && client.activeConfigModified"
                    color="warning"
                    class="current-config-tag"
                >
                    配置已修改
                </a-tag>
                <a-button
                    v-if="backup.enabled && client.activeConfigModified"
                    type="primary"
                    ghost
                    size="small"
                    style="margin-left: 4px; font-size: 12px; height: 22px; line-height: 20px;"
                    @click="$emit('openSyncDialog', backup.id, backup.name)"
                    :loading="isSaving"
                >
                    <SyncOutlined /> 同步
                </a-button>
                <a-button
                    type="text"
                    size="small"
                    class="rename-button"
                    @click="$emit('openRenameDialog', backup)"
                >
                    <EditOutlined />
                </a-button>
            </div>
            
            <div v-if="backup.config" class="config-summary-line">
                <div v-if="backup.config.model" class="config-flow">
                    <a-tag color="purple" class="merged-mode-tag">模型</a-tag>
                    <span class="model-text">{{ backup.config.model }}</span>
                </div>
                <div class="config-flow">
                    <a-tooltip placement="right">
                        <template #title>
                            <div v-if="backup.config.connectionMode === ClientConnectionMode.GATEWAY">
                                客户端通过 GtAIGateway 连接上游。<br/>
                                支持高级功能，如抓取请求流量进行分析、自动协议转换、提升缓存命中率等。
                            </div>
                            <div v-else-if="backup.config.connectionMode === ClientConnectionMode.OFFICIAL">
                                官方模式：客户端直接连接官方服务
                            </div>
                            <div v-else>
                                供应商模式：客户端直接连接上游供应商，不经过 GtAIGateway 代理。
                            </div>
                        </template>
                        <a-tag :color="getConnectionModeColor(backup.config.connectionMode)" class="merged-mode-tag" style="cursor: help;">
                            {{ getConnectionModeLabel(backup.config.connectionMode) }}
                            <InfoCircleOutlined style="margin-left: 2px;" />
                        </a-tag>
                    </a-tooltip>
                    <template v-if="isGatewayConfig(backup.config)">
                        <span>🤖</span>
                        <ArrowRightOutlined class="flow-arrow" />
                        <img src="/favicon.svg" class="flow-logo" alt="Gateway" />
                        <ArrowRightOutlined class="flow-arrow" />
                        <span>☁️</span>
                    </template>
                    <template v-else-if="backup.config.connectionMode === ClientConnectionMode.OFFICIAL">
                        <span>🤖</span>
                        <ArrowRightOutlined class="flow-arrow" />
                        <span>🏢</span>
                    </template>
                    <template v-else>
                        <span>🤖</span>
                        <ArrowRightOutlined class="flow-arrow" />
                        <span>☁️</span>
                    </template>
                </div>
            </div>
            <div v-else class="config-summary-line">
                <a-tag color="default">未配置</a-tag>
                <span class="config-muted">未检测到有效配置</span>
            </div>
        </div>
        
        <div class="config-row-actions">
            <a-button
                size="small"
                style="font-size: 13px;"
                :disabled="!backup.config"
                @click="$emit('openConfigDialog', backup, 'edit')"
            >
                <EditOutlined />
                修改
            </a-button>
            <a-button
                size="small"
                style="font-size: 13px;"
                :disabled="!backup.config"
                @click="$emit('openConfigDialog', backup, 'detail')"
            >
                <InfoCircleOutlined />
                查看
            </a-button>
            <a-button
                danger
                size="small"
                style="font-size: 13px;"
                :loading="isDeleting"
                @click="$emit('deleteConfig', backup)"
            >
                <DeleteOutlined />
                删除
            </a-button>
        </div>
    </div>
</template>

<script setup lang="ts">
import {
    ArrowRightOutlined,
    CheckCircleFilled,
    DeleteOutlined,
    EditOutlined,
    InfoCircleOutlined,
    SyncOutlined
} from '@ant-design/icons-vue';
import { ClientConnectionMode } from '@/types/clientConfig';
import type { ClientConfigStatus, ClientConfigBackupInfo } from '@/types/clientConfig';
import {
    getConnectionModeLabel,
    getConnectionModeColor,
    isGatewayConfig,
} from '@/utils/clientManagerUtils';

defineProps<{
    backup: ClientConfigBackupInfo;
    client: ClientConfigStatus;
    isRestoring: boolean;
    isDeleting: boolean;
    isSaving: boolean;
}>();

defineEmits<{
    (e: 'applyConfig', backupId: number): void;
    (e: 'openSyncDialog', backupId: number, backupName: string): void;
    (e: 'openRenameDialog', backup: ClientConfigBackupInfo): void;
    (e: 'openConfigDialog', backup: ClientConfigBackupInfo, mode: 'edit' | 'detail'): void;
    (e: 'deleteConfig', backup: ClientConfigBackupInfo): void;
}>();
</script>

<style scoped>
.config-row {
    align-items: center;
    border: 1px solid var(--border-color, #f0f0f0);
    border-radius: 8px;
    display: grid;
    gap: 16px;
    grid-template-columns: auto minmax(0, 1fr) auto;
    padding: 12px 16px;
    transition: all 0.2s ease;
}

.config-row:not(.active-config-row) {
    opacity: 0.65;
    filter: grayscale(100%);
}

.config-row:not(.active-config-row):hover {
    opacity: 1;
    filter: grayscale(0%);
}

.icon-placeholder {
    width: 20px;
    height: 20px;
}

.check-state-button {
    align-items: center;
    background: transparent;
    border: 0;
    cursor: pointer;
    display: inline-flex;
    height: 20px;
    justify-content: center;
    padding: 0;
    width: 20px;
}

.empty-check-circle {
    border: 2px solid var(--border-color, #d9d9d9);
    border-radius: 50%;
    transition: border-color 0.2s;
}

.empty-check-circle:hover {
    border-color: var(--accent-primary, #1677ff);
}

.checked-check-button {
    color: var(--accent-primary, #1677ff);
}

.current-config-icon {
    font-size: 20px;
}

.config-row-content {
    min-width: 0;
}

.config-row-name {
    align-items: center;
    display: flex;
    gap: 6px;
    margin-bottom: 4px;
}

.config-row-name > span {
    font-weight: 500;
    color: var(--text-secondary, #8c8c8c);
    font-size: 14px;
}

.current-config-tag {
    font-size: 12px;
    line-height: 20px;
    margin-left: 4px;
    padding: 0 4px;
}

.merged-mode-tag {
    border-width: 1px !important;
    border-style: solid !important;
}

.merged-mode-tag.ant-tag-blue {
    border-color: #91caff !important;
}

.merged-mode-tag.ant-tag-green {
    border-color: #b7eb8f !important;
}

.merged-mode-tag.ant-tag-purple {
    border-color: #d3adf7 !important;
}

.rename-button {
    color: var(--text-tertiary, #bfbfbf);
    margin-left: 4px;
}

.rename-button:hover {
    color: var(--accent-primary, #1677ff);
}

.config-summary-line {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 13px;
    color: var(--text-secondary, #8c8c8c);
}

.config-flow {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 13px;
}

.flow-arrow {
    font-size: 10px;
    color: var(--text-tertiary, #bfbfbf);
}

.flow-logo {
    width: 14px;
    height: 14px;
    filter: grayscale(100%);
    opacity: 0.6;
}

.active-config-row .flow-logo {
    filter: grayscale(0%);
    opacity: 1;
}

.merged-mode-tag {
    margin-right: 4px;
    font-size: 12px;
    line-height: 18px;
    padding: 0 6px;
    border: none;
}

.model-text {
    font-weight: 500;
    color: var(--text-primary);
}

.config-muted {
    font-size: 13px;
}

.config-row-actions {
    display: flex;
    gap: 8px;
    opacity: 0.5;
    transition: opacity 0.2s;
}

.config-row:hover .config-row-actions,
.active-config-row .config-row-actions {
    opacity: 1;
}
</style>
