<template>
    <div class="client-manager">
        <div class="page-header">
            <h2 class="page-title">客户端管理</h2>
            <p class="page-desc">管理和切换本地AI客户端所使用的模型配置。可以给每个客户端建立多份配置，从而方便快捷地在不同的模型服务中切换。</p>
        </div>

        <a-spin :spinning="loading">
            <a-alert
                v-if="!available"
                type="warning"
                show-icon
                message="客户端管理不可用"
                :description="unavailableReason || '请本地安装使用。'"
                class="unavailable-alert"
            />

            <div v-if="available" class="toolbar">
                <a-button :loading="loading" @click="loadStatus">
                    <ReloadOutlined />
                    重新检测
                </a-button>
            </div>

            <a-tabs v-if="available" v-model:activeKey="activeClient" class="client-tabs">
                <a-tab-pane v-for="client in clients" :key="client.client">
                    <template #tab>
                        <div class="tab-title">
                            <span>{{ client.displayName }}</span>
                            <a-badge
                                :status="client.configured ? 'processing' : client.installed ? 'success' : 'default'"
                            />
                        </div>
                    </template>

                    <a-card class="client-card">
                        <div class="client-main">
                            <div class="client-info">
                                <div class="client-title-row">
                                    <h3 class="client-title">{{ client.displayName }}</h3>
                                    <a-tag :color="client.installed ? 'green' : 'default'">
                                        {{ client.installed ? '已安装' : '未检测到' }}
                                    </a-tag>
                                    <a-tag :color="client.configured ? 'blue' : 'default'">
                                        {{ client.configured ? '已配置' : '未配置' }}
                                    </a-tag>
                                    <div style="flex: 1"></div>
                                    <a-button
                                        size="small"
                                        style="font-size: 13px;"
                                        :disabled="!client.installed"
                                        :loading="backingUpClient === client.client"
                                        @click="importFromLocal(client)"
                                    >
                                        <ImportOutlined /> 从本地配置导入
                                    </a-button>
                                    <a-button
                                        type="primary"
                                        size="small"
                                        style="font-size: 13px;"
                                        :disabled="!client.installed"
                                        :loading="savingClient === client.client"
                                        @click="openConfigDialog(client)"
                                    >
                                        <PlusOutlined /> 新配置
                                    </a-button>
                                </div>
                                <div class="config-row-list">
                                    <div
                                        v-for="backup in client.backups"
                                        :key="backup.id"
                                        class="config-row saved-config-row"
                                        :class="{ 'active-config-row': backup.enabled }"
                                    >
                                        <div class="icon-placeholder" style="display: flex; align-items: center; justify-content: center;" v-if="restoringBackupId === backup.id">
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
                                            @click="applyConfig(client.client, backup.id)"
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
                                                    @click="openSyncDialog(client.client, backup.id)"
                                                    :loading="savingClient === client.client"
                                                >
                                                    <SyncOutlined /> 同步
                                                </a-button>
                                                <a-button
                                                    type="text"
                                                    size="small"
                                                    class="rename-button"
                                                    @click="openRenameDialog(client.client, backup)"
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
                                                    <a-tooltip>
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
                                                @click="openConfigDialog(client, backup)"
                                            >
                                                <EditOutlined />
                                                修改
                                            </a-button>
                                            <a-button
                                                size="small"
                                                style="font-size: 13px;"
                                                :disabled="!backup.config"
                                                @click="openConfigDialog(client, backup, 'detail')"
                                            >
                                                <InfoCircleOutlined />
                                                查看
                                            </a-button>
                                            <a-button
                                                danger
                                                size="small"
                                                style="font-size: 13px;"
                                                :loading="deletingBackupId === backup.id"
                                                @click="deleteConfig(client.client, backup)"
                                            >
                                                <DeleteOutlined />
                                                删除
                                            </a-button>
                                        </div>
                                    </div>

                                    <a-empty
                                        v-if="client.backups.length === 0"
                                        description="暂无配置"
                                        class="config-empty-state"
                                    />
                                </div>
                                <div v-if="client.message" class="client-message">{{ client.message }}</div>
                            </div>
                        </div>
                    </a-card>
                </a-tab-pane>
            </a-tabs>

            <a-empty
                v-if="!loading && clients.length === 0"
                description="未检测到可配置客户端"
                class="empty-state"
            />
        </a-spin>

        <ConfigDialog
            v-model:open="configDialogVisible"
            :mode="configDialogMode"
            :selected-client="configDialogClient"
            :backup="configDialogBackup"
            :local-config="configDialogLocalConfig"
            :users="users"
            :models="models"
            :vendors="vendors"
            :vendor-preset-urls="vendorPresetUrls"
            :default-gateway-url="configDialogDefaultUrl"
            @save="handleConfigSave"
        />

        <RenameDialog
            v-model:open="renameDialogVisible"
            :client="renameForm.client"
            :backup-id="renameForm.backupId"
            :initial-name="renameForm.name"
            @renamed="handleRename"
        />

        <SyncDialog
            v-model:open="syncDialogVisible"
            :client="syncDialogClient"
            :backup-id="syncDialogBackupId"
            :backup-name="syncDialogBackupName"
            @synced="loadStatus"
        />
    </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref, watch, createVNode } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { message, Modal } from 'ant-design-vue/es';
import { ArrowRightOutlined, CheckCircleFilled, DeleteOutlined, EditOutlined, ImportOutlined, InfoCircleOutlined, ReloadOutlined, PlusOutlined, SyncOutlined } from '@ant-design/icons-vue';
import {
    applyClientConfig,
    createClientConfigBackup,
    deleteClientConfigBackup,
    getClientConfigStatus,
    readLocalConfig,
    updateClientConfigBackup,
} from '@/api/clientConfig';
import { ClientName, ClientConnectionMode } from '@/types/clientConfig';
import type {
    ClientConfigBackupInfo,
    ClientConfigStatus,
    CurrentClientConfig,
} from '@/types/clientConfig';
import { listUsers } from '@/api/user';
import { listModels } from '@/api/model';
import type { User } from '@/types/user';
import type { Model } from '@/types/model';
import { normalizeListResponse } from '@/utils/listResponse';
import { getVendorPresetUrls, listVendors } from '@/api/vendor';
import type { Vendor } from '@/types/vendor';
import { getBaseURL } from '@/utils/request';
import ConfigDialog from '@/components/clientConfig/ConfigDialog.vue';
import RenameDialog from '@/components/clientConfig/RenameDialog.vue';
import SyncDialog from '@/components/clientConfig/SyncDialog.vue';
import {
    getConnectionModeLabel,
    getConnectionModeColor,
    isGatewayConfig,
} from '@/utils/clientManagerUtils';


const loading = ref(false);
const available = ref(true);
const unavailableReason = ref('');
const savingClient = ref<ClientName | ''>('');
const backingUpClient = ref<ClientName | ''>('');
const deletingBackupId = ref<number | null>(null);
const restoringBackupId = ref<number | null>(null);
const clients = ref<ClientConfigStatus[]>([]);
const activeClient = ref<ClientName | ''>('');
const route = useRoute();
const router = useRouter();
const users = ref<User[]>([]);
const models = ref<Model[]>([]);
const vendors = ref<Vendor[]>([]);
const vendorPresetUrls = ref<Record<string, Record<string, string>>>({});

const configDialogVisible = ref(false);
const configDialogMode = ref<'create' | 'edit' | 'detail'>('create');
const configDialogClient = ref<ClientConfigStatus | null>(null);
const configDialogBackup = ref<ClientConfigBackupInfo | null>(null);
const configDialogDefaultUrl = ref('');
const configDialogLocalConfig = ref<CurrentClientConfig | null>(null);

const renameDialogVisible = ref(false);
const renameForm = reactive({
    client: ClientName.CLAUDE_CODE as ClientName,
    backupId: 0,
    name: '',
});

const syncDialogVisible = ref(false);
const syncDialogClient = ref<ClientName>(ClientName.CLAUDE_CODE);
const syncDialogBackupId = ref(0);
const syncDialogBackupName = ref('');

watch(configDialogVisible, (isOpen) => {
    if (!isOpen) configDialogLocalConfig.value = null;
});

watch(activeClient, (val) => {
    if (val && val !== route.params.tab) {
        router.replace({ name: 'ClientManager', params: { tab: val } });
    }
});


onMounted(() => {
    const tabParam = route.params.tab;
    if (tabParam && typeof tabParam === 'string') activeClient.value = tabParam as ClientName;
    void loadStatus();
});

async function loadStatus(): Promise<void> {
    loading.value = true;
    try {
        const response = await getClientConfigStatus();
        available.value = response.available;
        unavailableReason.value = response.reason || '';
        clients.value = response.clients;
        const firstClient = response.clients[0];
        if (!activeClient.value && firstClient) {
            const tabParam = route.params.tab;
            activeClient.value = (tabParam && typeof tabParam === 'string' ? tabParam : firstClient.client) as ClientName;
        }
    } finally {
        loading.value = false;
    }
}

async function loadDialogOptions(): Promise<void> {
    const [userResult, modelResult, vendorResult, presetUrls] = await Promise.all([
        listUsers({ pageSize: 1000 }),
        listModels({ pageSize: 1000 }),
        listVendors({ pageSize: 1000 }),
        getVendorPresetUrls(),
    ]);
    users.value = normalizeListResponse(userResult).list;
    models.value = normalizeListResponse(modelResult).list;
    vendors.value = normalizeListResponse(vendorResult).list;
    vendorPresetUrls.value = presetUrls;
}

function getDefaultGatewayUrl(client?: ClientConfigStatus): string {
    const baseUrl = getBaseURL();
    let url = '';
    if (/^https?:\/\//.test(baseUrl)) {
        url = baseUrl.replace(/\/+$/, '').replace('://localhost', '://127.0.0.1');
    } else if (baseUrl === '/api' && import.meta.env.DEV) {
        url = 'http://127.0.0.1:8720';
    } else {
        url = window.location.origin.replace('://localhost', '://127.0.0.1');
    }
    if (client && client.defaultGatewaySuffix) {
        return `${url}${client.defaultGatewaySuffix}`;
    }
    return url;
}

async function openConfigDialog(client: ClientConfigStatus, backup?: ClientConfigBackupInfo, mode?: 'create' | 'edit' | 'detail'): Promise<void> {
    const resolvedMode = mode || (backup ? 'edit' : 'create');
    await loadDialogOptions();
    configDialogClient.value = client;
    configDialogBackup.value = backup || null;
    configDialogMode.value = resolvedMode;
    configDialogDefaultUrl.value = getDefaultGatewayUrl(client);
    configDialogVisible.value = true;
}

async function handleConfigSave(request: any): Promise<void> {
    const client = configDialogClient.value;
    if (!client) return;

    const backup = configDialogBackup.value;

    if (backup) {
        if (backup.enabled) {
            const clientName = client.displayName || '客户端';
            Modal.confirm({
                title: `保存并应用 ${clientName} 配置？`,
                content: createVNode('div', null, [
                    createVNode('div', null, `将这一份配置写入 ${clientName} 在本机的配置文件中`),
                    createVNode('div', { 
                        style: 'margin-top: 12px; padding: 8px 12px; background-color: #fffbe6; border: 1px solid #ffe58f; border-radius: 6px; color: #d46b08; font-size: 13px;' 
                    }, `注意：切换后，请退出 ${clientName} 再重新打开，客户端将会使用新配置了`),
                ]),
                okText: '保存并写入',
                okType: 'primary',
                cancelText: '取消',
                async onOk() {
                    const status = await updateClientConfigBackup({
                        client: request.client,
                        backupId: backup.id,
                        ...request,
                    });
                    updateClientStatus(status);
                    
                    const applyStatus = await applyClientConfig({ client: request.client as ClientName, backupId: backup.id });
                    updateClientStatus(applyStatus);
                    
                    message.success('配置已保存并生效');
                    configDialogVisible.value = false;
                }
            });
            return;
        }

        const status = await updateClientConfigBackup({
            client: request.client,
            backupId: backup.id,
            ...request,
        });
        updateClientStatus(status);
        message.success('配置已更新');
    } else {
        if (!configDialogLocalConfig.value && client.backupCount < 1) {
            const shouldContinue = await confirmInitialBackup(client);
            if (!shouldContinue) return;
        }
        savingClient.value = request.client;
        try {
            const backup = await createClientConfigBackup({
                client: request.client,
                configContent: request,
            });
            addBackup(backup);
            message.success(configDialogLocalConfig.value ? '配置已导入' : '配置已创建');
        } finally {
            savingClient.value = '';
        }
    }
    configDialogVisible.value = false;
}

function confirmInitialBackup(client: ClientConfigStatus): Promise<boolean> {
    return new Promise((resolve) => {
        Modal.confirm({
            title: '创建配置备份',
            content: `${client.displayName} 当前没有配置备份。是否先备份当前配置？`,
            okText: '备份并继续',
            cancelText: '直接创建',
            async onOk() {
                await backupCurrentConfig(client.client, false);
                resolve(true);
            },
            onCancel() {
                resolve(true);
            },
        });
    });
}


function openRenameDialog(client: ClientName, backup: ClientConfigBackupInfo): void {
    renameForm.client = client;
    renameForm.backupId = backup.id;
    renameForm.name = backup.name;
    renameDialogVisible.value = true;
}

function handleRename(backup: any): void {
    updateBackupInfo(backup);
    renameDialogVisible.value = false;
}


async function importFromLocal(client: ClientConfigStatus): Promise<void> {
    backingUpClient.value = client.client;
    try {
        const localConfig = await readLocalConfig(client.client);
        await loadDialogOptions();
        configDialogClient.value = client;
        configDialogBackup.value = null;
        configDialogMode.value = 'create';
        configDialogDefaultUrl.value = getDefaultGatewayUrl(client);
        configDialogLocalConfig.value = localConfig;
        configDialogVisible.value = true;
    } catch {
        message.error('读取本地配置失败');
    } finally {
        backingUpClient.value = '';
    }
}


async function backupCurrentConfig(client: ClientName, showSuccess = true): Promise<void> {
    const target = clients.value.find(item => item.client === client);
    if (!target) return;

    backingUpClient.value = client;
    try {
        const backup = await createClientConfigBackup({ client });
        target.backups = [backup, ...target.backups];
        target.backupCount = target.backups.length;
        target.backupExists = target.backupCount > 0;
        if (showSuccess) {
            message.success(`${target.displayName} 已从本地配置新建`);
        }
    } finally {
        backingUpClient.value = '';
    }
}

function deleteConfig(client: ClientName, backup: ClientConfigBackupInfo): void {
    Modal.confirm({
        title: `删除配置「${backup.name}」？`,
        content: backup.enabled
            ? '该配置当前处于启用状态。删除后本地客户端配置文件不会被修改，但列表中将不再有启用配置。'
            : '删除后不可恢复。',
        okText: '删除',
        okType: 'danger',
        cancelText: '取消',
        async onOk() {
            deletingBackupId.value = backup.id;
            try {
                const status = await deleteClientConfigBackup({ client, backupId: backup.id });
                updateClientStatus(status);
                message.success('配置已删除');
            } finally {
                deletingBackupId.value = null;
            }
        },
    });
}

function openSyncDialog(client: ClientName, backupId: number): void {
    const target = clients.value.find(item => item.client === client);
    const backup = target?.backups.find(item => item.id === backupId);
    if (!backup) return;
    syncDialogClient.value = client;
    syncDialogBackupId.value = backupId;
    syncDialogBackupName.value = backup.name;
    syncDialogVisible.value = true;
}

function applyConfig(client: ClientName, backupId?: number): void {
    const target = clients.value.find(item => item.client === client);
    const selectedBackup = target?.backups.find(item => item.id === backupId) || target?.backups[0];
    if (!selectedBackup) {
        message.error('没有可恢复的配置');
        return;
    }

    const clientName = target?.displayName || '客户端';
    Modal.confirm({
        title: `切换 ${clientName} 配置？`,
        content: createVNode('div', null, [
            createVNode('div', null, `将这一份配置写入 ${clientName} 在本机的配置文件中`),
            createVNode('div', { 
                style: 'margin-top: 12px; padding: 8px 12px; background-color: #fffbe6; border: 1px solid #ffe58f; border-radius: 6px; color: #d46b08; font-size: 13px;' 
            }, `注意：切换后，请退出 ${clientName} 再重新打开，客户端将会使用新配置了`),
        ]),
        okText: '切换',
        okType: 'danger',
        cancelText: '取消',
        async onOk() {
            restoringBackupId.value = selectedBackup.id;
            try {
                const status = await applyClientConfig({ client, backupId: selectedBackup.id });
                updateClientStatus(status);
                message.success('配置切换成功');
            } finally {
                restoringBackupId.value = null;
            }
        },
    });
}

function updateClientStatus(status: ClientConfigStatus): void {
    const index = clients.value.findIndex(item => item.client === status.client);
    if (index >= 0) {
        clients.value[index] = status;
    } else {
        clients.value.push(status);
    }
}

function updateBackupInfo(backup: ClientConfigBackupInfo): void {
    const client = clients.value.find(item => item.client === backup.client);
    const index = client?.backups.findIndex(item => item.id === backup.id) ?? -1;
    if (!client || index < 0) return;
    client.backups[index] = backup;
}

function addBackup(backup: ClientConfigBackupInfo): void {
    const client = clients.value.find(item => item.client === backup.client);
    if (!client) return;
    client.backups.push(backup);
    client.backupCount = client.backups.length;
    client.backupExists = true;
}
</script>

<style scoped>
.client-manager {
    background: var(--bg-page);
    min-height: calc(100vh - 64px);
    padding: 24px;
    max-width: 980px;
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
    color: var(--text-secondary, #8c8c8c);
    font-size: 14px;
}

.toolbar {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 12px;
}

.unavailable-alert {
    max-width: 720px;
}

.client-tabs {
    background: var(--component-bg, #ffffff);
    border: 1px solid var(--border-color, #f0f0f0);
    border-radius: 8px;
    padding: 0 18px 18px;
}

.tab-title {
    display: flex;
    align-items: center;
    gap: 8px;
}

.client-card {
    border: none;
    border-radius: 8px;
}

.client-card :deep(.ant-card-body) {
    padding: 16px 0 0;
}

.client-main {
    display: block;
}

.client-info {
    min-width: 0;
    flex: 1;
}

.client-title-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 8px;
}

.client-title {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
}

.config-row-list {
    display: grid;
    gap: 10px;
}

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

.active-config-row .config-row-name > span {
    color: var(--text-primary);
}

.current-config-tag {
    font-size: 11px;
    line-height: 18px;
    padding: 0 6px;
}

.config-summary-line {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.config-flow {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--text-secondary, #8c8c8c);
    background: var(--bg-color-secondary, #fafafa);
    padding: 2px 8px 2px 2px;
    border-radius: 6px;
    font-size: 13px;
    border: 1px solid var(--border-color, #f0f0f0);
}

.flow-arrow {
    color: var(--text-secondary, #8c8c8c);
    font-size: 12px;
}

.flow-logo {
    height: 16px;
    width: 16px;
}

.model-text {
    color: var(--text-primary, #262626);
    font-weight: 500;
}

.merged-mode-tag {
    margin-right: 2px;
    border-radius: 4px;
    border-color: transparent;
    font-size: 12px;
    line-height: 18px;
    padding: 0 8px;
}

.config-muted {
    color: var(--text-secondary, #8c8c8c);
    font-size: 13px;
}

.config-row-actions {
    display: flex;
    gap: 4px;
}

.config-empty-state {
    padding: 24px 0;
}

.client-message {
    color: var(--text-secondary, #8c8c8c);
    font-size: 12px;
    margin-top: 8px;
}

.empty-state {
    padding: 48px 0;
}
</style>
