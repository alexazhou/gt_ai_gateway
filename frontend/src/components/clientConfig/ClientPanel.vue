<template>
    <a-card class="client-card">
        <div class="client-main">
            <div class="client-info">
                <div class="client-title-row">
                    <h3 class="client-title">{{ client.displayName }}</h3>
                    <a-tag :color="client.installed ? 'green' : 'default'">
                        {{ client.installed ? '已安装' : '未检测到' }}
                    </a-tag>
                    <div style="flex: 1"></div>
                    <a-button
                        size="small"
                        style="font-size: 13px;"
                        :disabled="!client.installed"
                        :loading="backingUp"
                        @click="importFromLocal"
                    >
                        <ImportOutlined /> 从本地配置导入
                    </a-button>
                    <a-button
                        type="primary"
                        size="small"
                        style="font-size: 13px;"
                        :disabled="!client.installed"
                        :loading="saving"
                        @click="openConfigDialog(undefined, 'create')"
                    >
                        <PlusOutlined /> 新配置
                    </a-button>
                </div>
                <div class="config-row-list">
                    <ClientConfigCard
                        v-for="backup in client.backups"
                        :key="backup.id"
                        :backup="backup"
                        :client="client"
                        :is-restoring="restoringBackupId === backup.id"
                        :is-saving="saving"
                        :is-deleting="deletingBackupId === backup.id"
                        @apply-config="applyConfig"
                        @open-sync-dialog="openSyncDialog"
                        @open-rename-dialog="openRenameDialog"
                        @open-config-dialog="openConfigDialog"
                        @delete-config="deleteConfig"
                    />

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

    <ConfigDialog
        v-model:open="configDialogVisible"
        :mode="configDialogMode"
        :selected-client="client"
        :backup="configDialogBackup"
        :local-config="configDialogLocalConfig"
        :default-gateway-url="configDialogDefaultUrl"
        @save="handleConfigSave"
    />

    <RenameDialog
        v-model:open="renameDialogVisible"
        :client="client.client"
        :backup-id="renameForm.backupId"
        :initial-name="renameForm.name"
        @renamed="onRefresh"
    />

    <SyncDialog
        v-model:open="syncDialogVisible"
        :client="client.client"
        :backup-id="syncDialogBackupId"
        :backup-name="syncDialogBackupName"
        @synced="onRefresh"
    />
</template>

<script setup lang="ts">
import { reactive, ref, watch, createVNode, type VNode } from 'vue';
import { message, Modal } from 'ant-design-vue/es';
import {
    ImportOutlined,
    PlusOutlined,
} from '@ant-design/icons-vue';
import {
    applyClientConfig,
    createClientConfigBackup,
    deleteClientConfigBackup,
    readLocalConfig,
    updateClientConfigBackup,
} from '@/api/clientConfig';
import { ClientName } from '@/types/clientConfig';
import type {
    ClientConfigStatus,
    ClientConfigBackupInfo,
    CurrentClientConfig,
    CreateClientConfigRequest,
} from '@/types/clientConfig';
import { getBaseURL } from '@/utils/request';
import ConfigDialog from '@/components/clientConfig/ConfigDialog.vue';
import RenameDialog from '@/components/clientConfig/RenameDialog.vue';
import SyncDialog from '@/components/clientConfig/SyncDialog.vue';
import ClientConfigCard from '@/components/clientConfig/ClientConfigCard.vue';

const props = defineProps<{
    client: ClientConfigStatus;
}>();

const emit = defineEmits<{
    (e: 'refresh'): void;
}>();

const saving = ref(false);
const backingUp = ref(false);
const deletingBackupId = ref<number | null>(null);
const restoringBackupId = ref<number | null>(null);

const configDialogVisible = ref(false);
const configDialogMode = ref<'create' | 'edit' | 'detail'>('create');
const configDialogBackup = ref<ClientConfigBackupInfo | null>(null);
const configDialogDefaultUrl = ref('');
const configDialogLocalConfig = ref<CurrentClientConfig | null>(null);

const renameDialogVisible = ref(false);
const renameForm = reactive({
    backupId: 0,
    name: '',
});

const syncDialogVisible = ref(false);
const syncDialogBackupId = ref(0);
const syncDialogBackupName = ref('');

watch(configDialogVisible, (isOpen) => {
    if (!isOpen) configDialogLocalConfig.value = null;
});

function getDefaultGatewayUrl(): string {
    const baseUrl = getBaseURL();
    let url = '';
    if (/^https?:\/\//.test(baseUrl)) {
        url = baseUrl.replace(/\/+$/, '').replace('://localhost', '://127.0.0.1');
    } else if (baseUrl === '/api' && import.meta.env.DEV) {
        url = 'http://127.0.0.1:8720';
    } else {
        url = window.location.origin.replace('://localhost', '://127.0.0.1');
    }
    if (props.client.defaultGatewaySuffix) {
        return `${url}${props.client.defaultGatewaySuffix}`;
    }
    return url;
}

function openConfigDialog(backup?: ClientConfigBackupInfo, mode?: 'create' | 'edit' | 'detail'): void {
    const resolvedMode = mode || (backup ? 'edit' : 'create');
    configDialogBackup.value = backup || null;
    configDialogMode.value = resolvedMode;
    configDialogDefaultUrl.value = getDefaultGatewayUrl();
    configDialogVisible.value = true;
}

async function handleConfigSave(request: CreateClientConfigRequest): Promise<void> {
    const backup = configDialogBackup.value;

    if (backup) {
        if (backup.enabled) {
            const clientName = props.client.displayName || '客户端';
            let restartHint: string | VNode[] = `注意：切换后，请退出 ${clientName} 再重新打开，客户端将会使用新配置。`;
            if (props.client.client === ClientName.CODEX) {
                restartHint = [
                    createVNode('div', { style: 'font-weight: 500; margin-bottom: 4px;' }, '注意：'),
                    createVNode('div', null, `1. 切换后，请彻底退出并重新打开 ${clientName}。`),
                    createVNode('div', { style: 'margin-top: 2px;' }, `2. 需要开启新会话才会切换到新模型（codex会将旧会话绑定到之前的模型）。`)
                ];
            }

            Modal.confirm({
                title: `保存并应用 ${clientName} 配置？`,
                content: createVNode('div', null, [
                    createVNode('div', null, `将这一份配置写入 ${clientName} 在本机的配置文件中`),
                    createVNode('div', { 
                        style: 'margin-top: 12px; padding: 8px 12px; background-color: #fffbe6; border: 1px solid #ffe58f; border-radius: 6px; color: #d46b08; font-size: 13px;' 
                    }, restartHint),
                ]),
                okText: '保存并写入',
                okType: 'primary',
                cancelText: '取消',
                async onOk() {
                    await updateClientConfigBackup({
                        ...request,
                        backupId: backup.id,
                    });
                    await applyClientConfig({ client: request.client, backupId: backup.id });
                    
                    message.success('配置已保存并生效');
                    configDialogVisible.value = false;
                    onRefresh();
                }
            });
            return;
        }

        await updateClientConfigBackup({
            ...request,
            backupId: backup.id,
        });
        message.success('配置已更新');
        onRefresh();
    } else {
        if (!configDialogLocalConfig.value && props.client.backupCount < 1) {
            const shouldContinue = await confirmInitialBackup();
            if (!shouldContinue) return;
        }
        saving.value = true;
        try {
            await createClientConfigBackup({
                client: request.client,
                configContent: request,
            });
            message.success(configDialogLocalConfig.value ? '配置已导入' : '配置已创建');
            onRefresh();
        } finally {
            saving.value = false;
        }
    }
    configDialogVisible.value = false;
}

function confirmInitialBackup(): Promise<boolean> {
    return new Promise((resolve) => {
        Modal.confirm({
            title: '创建配置备份',
            content: `${props.client.displayName} 当前没有配置备份。是否先备份当前配置？`,
            okText: '备份并继续',
            cancelText: '直接创建',
            async onOk() {
                await backupCurrentConfig(false);
                resolve(true);
            },
            onCancel() {
                resolve(true);
            },
        });
    });
}

function openRenameDialog(backup: ClientConfigBackupInfo): void {
    renameForm.backupId = backup.id;
    renameForm.name = backup.name;
    renameDialogVisible.value = true;
}

async function importFromLocal(): Promise<void> {
    backingUp.value = true;
    try {
        const localConfig = await readLocalConfig(props.client.client);
        configDialogBackup.value = null;
        configDialogMode.value = 'create';
        configDialogDefaultUrl.value = getDefaultGatewayUrl();
        configDialogLocalConfig.value = localConfig;
        configDialogVisible.value = true;
    } catch {
        message.error('读取本地配置失败');
    } finally {
        backingUp.value = false;
    }
}

async function backupCurrentConfig(showSuccess = true): Promise<void> {
    backingUp.value = true;
    try {
        await createClientConfigBackup({ client: props.client.client });
        if (showSuccess) {
            message.success(`${props.client.displayName} 已从本地配置新建`);
        }
        onRefresh();
    } finally {
        backingUp.value = false;
    }
}

function deleteConfig(backup: ClientConfigBackupInfo): void {
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
                await deleteClientConfigBackup({ client: props.client.client, backupId: backup.id });
                message.success('配置已删除');
                onRefresh();
            } finally {
                deletingBackupId.value = null;
            }
        },
    });
}

function openSyncDialog(backupId: number, backupName: string): void {
    syncDialogBackupId.value = backupId;
    syncDialogBackupName.value = backupName;
    syncDialogVisible.value = true;
}

function applyConfig(backupId: number): void {
    const selectedBackup = props.client.backups.find(item => item.id === backupId);
    if (!selectedBackup) {
        message.error('没有可恢复的配置');
        return;
    }

    const clientName = props.client.displayName || '客户端';
    let restartHint: string | VNode[] = `注意：切换后，请退出 ${clientName} 再重新打开，客户端将会使用新配置。`;
    if (props.client.client === ClientName.CODEX) {
        restartHint = [
            createVNode('div', { style: 'font-weight: 500; margin-bottom: 4px;' }, '注意：'),
            createVNode('div', null, `1. 切换后，请彻底退出并重新打开 ${clientName}。`),
            createVNode('div', { style: 'margin-top: 2px;' }, `2. 需要开启新会话才会切换到新模型（codex会将旧会话绑定到之前的模型）。`)
        ];
    }

    Modal.confirm({
        title: `切换 ${clientName} 配置？`,
        content: createVNode('div', null, [
            createVNode('div', null, `将这一份配置写入 ${clientName} 在本机的配置文件中`),
            createVNode('div', { 
                style: 'margin-top: 12px; padding: 8px 12px; background-color: #fffbe6; border: 1px solid #ffe58f; border-radius: 6px; color: #d46b08; font-size: 13px;' 
            }, restartHint),
        ]),
        okText: '切换',
        okType: 'danger',
        cancelText: '取消',
        async onOk() {
            restoringBackupId.value = selectedBackup.id;
            try {
                await applyClientConfig({ client: props.client.client, backupId: selectedBackup.id });
                message.success('配置切换成功');
                onRefresh();
            } finally {
                restoringBackupId.value = null;
            }
        },
    });
}

function onRefresh() {
    emit('refresh');
}
</script>

<style scoped>
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



.config-empty-state {
    margin: 32px 0;
}

.client-message {
    color: var(--text-secondary, #8c8c8c);
    font-size: 13px;
    margin-top: 16px;
    padding: 8px 12px;
    background: var(--bg-hover, #f5f5f5);
    border-radius: 6px;
}
</style>
