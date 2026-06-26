<template>
    <div class="client-manager">
        <div class="page-header">
            <h2 class="page-title">客户端管理</h2>
            <p class="page-desc">为本机客户端写入网关配置。点击客户端内的配置按钮后选择用户和模型。</p>
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
                                    <div class="config-row current-config-row">
                                        <CheckCircleFilled class="current-config-icon" />
                                        <div class="config-row-content">
                                            <div class="config-row-name config-row-name-with-action">
                                                <span>{{ getCurrentConfigName(client) }}</span>
                                            </div>
                                            <template v-if="client.currentConfig">
                                                <div class="config-summary-line">
                                                    <div v-if="client.currentConfig.model" class="config-flow">
                                                        <a-tag color="purple" class="merged-mode-tag">模型</a-tag>
                                                        <span class="model-text">{{ client.currentConfig.model }}</span>
                                                    </div>
                                                    <div class="config-flow">
                                                        <a-tag :color="getConnectionModeColor(client.currentConfig.connectionMode)" class="merged-mode-tag">
                                                            {{ getConnectionModeLabel(client.currentConfig.connectionMode) }}
                                                        </a-tag>
                                                        <template v-if="isGatewayConfig(client.currentConfig)">
                                                            <span>🤖</span>
                                                            <ArrowRightOutlined class="flow-arrow" />
                                                            <img src="/favicon.svg" class="flow-logo" alt="Gateway" />
                                                            <ArrowRightOutlined class="flow-arrow" />
                                                            <span>☁️</span>
                                                        </template>
                                                        <template v-else>
                                                            <span>🤖</span>
                                                            <ArrowRightOutlined class="flow-arrow" />
                                                            <span>☁️</span>
                                                        </template>
                                                    </div>
                                                </div>
                                            </template>
                                            <div v-else class="config-summary-line">
                                                <a-tag color="default">未配置</a-tag>
                                                <span class="config-muted">未检测到有效配置</span>
                                            </div>
                                        </div>
                                        <div class="config-row-actions">
                                            <a-button
                                                size="small"
                                                style="font-size: 13px;"
                                                :disabled="!client.currentConfig"
                                                @click="openDetailDialog(client, client.currentConfig, getCurrentConfigName(client))"
                                            >
                                                <InfoCircleOutlined />
                                                查看
                                            </a-button>
                                            <a-button
                                                type="primary"
                                                size="small"
                                                style="font-size: 13px;"
                                                :disabled="!client.installed"
                                                :loading="savingClient === client.client"
                                                @click="openConfigDialog(client)"
                                            >
                                                <ToolOutlined />
                                                修改
                                            </a-button>
                                            <a-button
                                                size="small"
                                                style="font-size: 13px;"
                                                :disabled="!client.installed"
                                                :loading="backingUpClient === client.client"
                                                @click="backupCurrentConfig(client.client)"
                                            >
                                                <CopyOutlined />
                                                复制
                                            </a-button>
                                        </div>
                                    </div>

                                    <div
                                        v-for="backup in client.backups"
                                        :key="backup.id"
                                        class="config-row saved-config-row"
                                    >
                                        <div class="icon-placeholder" style="display: flex; align-items: center; justify-content: center;" v-if="restoringBackupId === backup.id">
                                            <a-spin size="small" />
                                        </div>
                                        <div
                                            v-else
                                            class="empty-check-circle"
                                            @click="restoreConfig(client.client, backup.id)"
                                        ></div>
                                        <div class="config-row-content">
                                            <div class="config-row-name config-row-name-with-action">
                                                <span>{{ backup.name }}</span>
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
                                                    <a-tag :color="getConnectionModeColor(backup.config.connectionMode)" class="merged-mode-tag">
                                                        {{ getConnectionModeLabel(backup.config.connectionMode) }}
                                                    </a-tag>
                                                    <template v-if="isGatewayConfig(backup.config)">
                                                        <span>🤖</span>
                                                        <ArrowRightOutlined class="flow-arrow" />
                                                        <img src="/favicon.svg" class="flow-logo" alt="Gateway" />
                                                        <ArrowRightOutlined class="flow-arrow" />
                                                        <span>☁️</span>
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
                                                @click="openDetailDialog(client, backup.config, backup.name)"
                                            >
                                                <InfoCircleOutlined />
                                                查看
                                            </a-button>

                                        </div>
                                    </div>


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

        <a-modal
            v-model:open="configDialogVisible"
            :title="configDialogTitle"
            :confirm-loading="savingClient === configForm.client"
            ok-text="配置"
            cancel-text="取消"
            width="560px"
            @ok="submitConfig"
        >
            <a-spin :spinning="dialogLoading">
                <a-form layout="vertical" class="config-form">

                    <a-tabs
                        v-model:activeKey="configForm.connectionMode"
                        class="connection-tabs"
                        @change="handleConnectionModeChange"
                    >
                        <a-tab-pane key="gateway" tab="通过 GT AI Gateway">
                            <a-form-item label="协议">
                                <a-input :value="selectedProtocolLabel" disabled />
                            </a-form-item>
                            <a-form-item label="服务端地址" required>
                                <a-input v-model:value="configForm.gatewayUrl" />
                            </a-form-item>
                            <a-form-item required>
                                <template #label>
                                    <span class="form-label-with-help">
                                        用户
                                        <a-tooltip title="选择一个网关用户，系统会把该用户的 Token 写入客户端配置，用于客户端访问当前网关。">
                                            <InfoCircleOutlined class="label-help-icon" />
                                        </a-tooltip>
                                    </span>
                                </template>
                                <a-select
                                    v-model:value="configForm.userId"
                                    show-search
                                    placeholder="选择用于写入客户端的用户 Token"
                                    :filter-option="filterSelectOption"
                                >
                                    <a-select-option
                                        v-for="user in users"
                                        :key="user.id"
                                        :value="user.id"
                                        :label="`${user.name} ${getUserTypeLabel(user.type)} ${user.status}`"
                                    >
                                        <div class="select-option-row">
                                            <a-tag class="select-tag" :color="getUserTypeColor(user.type)">
                                                {{ getUserTypeLabel(user.type) }}
                                            </a-tag>
                                            <span class="select-option-name">{{ user.name }}</span>
                                            <a-tag v-if="user.status !== 'active'" class="select-tag" color="red">
                                                已禁用
                                            </a-tag>
                                        </div>
                                    </a-select-option>
                                    <template #labelRender="{ value }">
                                        <div v-if="findUser(Number(value))" class="select-option-row selected-option">
                                            <a-tag class="select-tag" :color="getUserTypeColor(findUser(Number(value))?.type)">
                                                {{ getUserTypeLabel(findUser(Number(value))?.type) }}
                                            </a-tag>
                                            <span class="select-option-name">{{ findUser(Number(value))?.name }}</span>
                                            <a-tag v-if="findUser(Number(value))?.status !== 'active'" class="select-tag" color="red">
                                                已禁用
                                            </a-tag>
                                        </div>
                                    </template>
                                </a-select>
                            </a-form-item>
                            <a-form-item label="模型" required>
                                <a-select
                                    v-model:value="configForm.model"
                                    show-search
                                    placeholder="选择网关模型"
                                    :filter-option="filterSelectOption"
                                >
                                    <a-select-option
                                        v-for="model in enabledModels"
                                        :key="model.id"
                                        :value="model.name"
                                        :label="model.name"
                                    >
                                        {{ model.name }}
                                    </a-select-option>
                                </a-select>
                            </a-form-item>
                        </a-tab-pane>

                        <a-tab-pane key="vendor" tab="直连上游供应商">
                            <a-form-item label="协议">
                                <a-input :value="selectedProtocolLabel" disabled />
                            </a-form-item>
                            <a-form-item label="供应商" required>
                                <a-select
                                    v-model:value="configForm.vendorId"
                                    show-search
                                    placeholder="选择上游供应商"
                                    :filter-option="filterSelectOption"
                                    @change="handleVendorChange"
                                >
                                    <a-select-option
                                        v-for="vendor in vendors"
                                        :key="vendor.id"
                                        :value="vendor.id"
                                        :label="`${vendor.name} ${getVendorTypeLabel(vendor.type)}`"
                                    >
                                        <div class="select-option-row">
                                            <a-tag
                                                class="select-tag"
                                                :color="getVendorTypeColor(vendor.type)"
                                                :style="getVendorTypeTagStyle(vendor.type)"
                                            >
                                                {{ getVendorTypeLabel(vendor.type) }}
                                            </a-tag>
                                            <span class="select-option-name">{{ vendor.name }}</span>
                                        </div>
                                    </a-select-option>
                                    <template #labelRender="{ value }">
                                        <div v-if="findVendor(Number(value))" class="select-option-row selected-option">
                                            <a-tag
                                                class="select-tag"
                                                :color="getVendorTypeColor(findVendor(Number(value))?.type)"
                                                :style="getVendorTypeTagStyle(findVendor(Number(value))?.type)"
                                            >
                                                {{ getVendorTypeLabel(findVendor(Number(value))?.type) }}
                                            </a-tag>
                                            <span class="select-option-name">{{ findVendor(Number(value))?.name }}</span>
                                        </div>
                                    </template>
                                </a-select>
                            </a-form-item>
                            <a-form-item label="模型" required>
                                <a-select
                                    v-model:value="configForm.upstreamModel"
                                    show-search
                                    placeholder="选择供应商模型"
                                    :filter-option="filterSelectOption"
                                >
                                    <a-select-option
                                        v-for="model in vendorModels"
                                        :key="model.id"
                                        :value="model.model_id"
                                        :label="model.model_id"
                                    >
                                        {{ model.model_id }}
                                    </a-select-option>
                                </a-select>
                            </a-form-item>
                        </a-tab-pane>
                    </a-tabs>
                    <a-form-item
                        v-if="configForm.client === ClientName.CLAUDE_CODE"
                        label="思考强度"
                    >
                        <a-select
                            v-model:value="configForm.effortLevel"
                            placeholder="选择思考强度"
                            allow-clear
                        >
                            <a-select-option value="low">低 (low)</a-select-option>
                            <a-select-option value="medium">中 (medium)</a-select-option>
                            <a-select-option value="high">高 (high)</a-select-option>
                        </a-select>
                    </a-form-item>
                </a-form>
            </a-spin>
        </a-modal>

        <a-modal
            v-model:open="detailDialogVisible"
            :title="detailDialogTitle"
            :footer="null"
            width="560px"
        >
            <a-empty v-if="!detailConfig" description="未检测到有效配置" />
            <a-form v-else layout="vertical" class="config-form readonly-config-form">

                <a-tabs
                    :activeKey="detailConfig.connectionMode"
                    class="connection-tabs"
                >
                    <a-tab-pane key="gateway" tab="通过 GT AI Gateway" :disabled="detailConfig.connectionMode !== 'gateway'">
                        <a-form-item label="协议">
                            <a-input :value="getProtocolLabel(detailConfig.protocol)" disabled />
                        </a-form-item>
                        <a-form-item label="服务端地址">
                            <a-input :value="detailConfig.backendUrl" disabled />
                        </a-form-item>
                        <a-form-item label="用户">
                            <a-select :value="detailConfig.gatewayUser?.id" disabled class="readonly-select">
                                <a-select-option
                                    v-for="user in users"
                                    :key="user.id"
                                    :value="user.id"
                                    :label="`${user.name} ${getUserTypeLabel(user.type)} ${user.status}`"
                                >
                                    <div class="select-option-row">
                                        <a-tag class="select-tag" :color="getUserTypeColor(user.type)">
                                            {{ getUserTypeLabel(user.type) }}
                                        </a-tag>
                                        <span class="select-option-name">{{ user.name }}</span>
                                        <a-tag v-if="user.status !== 'active'" class="select-tag" color="red">
                                            已禁用
                                        </a-tag>
                                    </div>
                                </a-select-option>
                                <template #labelRender="{ value }">
                                    <div v-if="findUser(Number(value))" class="select-option-row selected-option">
                                        <a-tag class="select-tag" :color="getUserTypeColor(findUser(Number(value))?.type)">
                                            {{ getUserTypeLabel(findUser(Number(value))?.type) }}
                                        </a-tag>
                                        <span class="select-option-name">{{ findUser(Number(value))?.name }}</span>
                                        <a-tag v-if="findUser(Number(value))?.status !== 'active'" class="select-tag" color="red">
                                            已禁用
                                        </a-tag>
                                    </div>
                                </template>
                            </a-select>
                        </a-form-item>
                        <a-form-item label="模型">
                            <a-select :value="detailConfig.model" disabled class="readonly-select">
                                <a-select-option :value="detailConfig.model">{{ detailConfig.model }}</a-select-option>
                            </a-select>
                        </a-form-item>
                    </a-tab-pane>

                    <a-tab-pane key="vendor" tab="直连上游供应商" :disabled="detailConfig.connectionMode !== 'vendor'">
                        <a-form-item label="协议">
                            <a-input :value="getProtocolLabel(detailConfig.protocol)" disabled />
                        </a-form-item>
                        <a-form-item label="供应商">
                            <a-select :value="findVendorByUrl(detailConfig.backendUrl, detailConfig.protocol)?.id" disabled class="readonly-select">
                                <a-select-option
                                    v-for="vendor in vendors"
                                    :key="vendor.id"
                                    :value="vendor.id"
                                    :label="`${vendor.name} ${getVendorTypeLabel(vendor.type)}`"
                                >
                                    <div class="select-option-row">
                                        <a-tag
                                            class="select-tag"
                                            :color="getVendorTypeColor(vendor.type)"
                                            :style="getVendorTypeTagStyle(vendor.type)"
                                        >
                                            {{ getVendorTypeLabel(vendor.type) }}
                                        </a-tag>
                                        <span class="select-option-name">{{ vendor.name }}</span>
                                    </div>
                                </a-select-option>
                                <template #labelRender="{ value }">
                                    <div v-if="findVendor(Number(value))" class="select-option-row selected-option">
                                        <a-tag
                                            class="select-tag"
                                            :color="getVendorTypeColor(findVendor(Number(value))?.type)"
                                            :style="getVendorTypeTagStyle(findVendor(Number(value))?.type)"
                                        >
                                            {{ getVendorTypeLabel(findVendor(Number(value))?.type) }}
                                        </a-tag>
                                        <span class="select-option-name">{{ findVendor(Number(value))?.name }}</span>
                                    </div>
                                </template>
                            </a-select>
                        </a-form-item>
                        <a-form-item label="模型">
                            <a-select :value="detailConfig.model" disabled class="readonly-select">
                                <a-select-option :value="detailConfig.model">{{ detailConfig.model }}</a-select-option>
                            </a-select>
                        </a-form-item>
                    </a-tab-pane>
                </a-tabs>
            </a-form>
        </a-modal>

        <a-modal
            v-model:open="renameDialogVisible"
            title="修改配置名称"
            :confirm-loading="renamingBackupId === renameForm.backupId"
            ok-text="保存"
            cancel-text="取消"
            width="420px"
            @ok="submitRenameConfig"
        >
            <a-form layout="vertical">
                <a-form-item label="名称" required>
                    <a-input v-model:value="renameForm.name" />
                </a-form-item>
            </a-form>
        </a-modal>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { message, Modal } from 'ant-design-vue/es';
import { ArrowRightOutlined, CheckCircleFilled, CopyOutlined, EditOutlined, InfoCircleOutlined, ReloadOutlined, ToolOutlined, PlusOutlined } from '@ant-design/icons-vue';
import {
    applyClientConfig,
    createClientConfigBackup,
    getClientConfigStatus,
    renameClientConfigBackup,
    restoreClientConfig,
} from '@/api/clientConfig';
import { ClientName } from '@/types/clientConfig';
import type {
    ClientConfigBackupInfo,
    ClientConfigStatus,
    ClientConnectionMode,
    ClientProtocol,
    CurrentClientConfig,
} from '@/types/clientConfig';
import { getBaseURL } from '@/utils/request';
import { listUsers } from '@/api/user';
import { listModels } from '@/api/model';
import type { User, UserType } from '@/types/user';
import type { Model } from '@/types/model';
import { normalizeListResponse } from '@/utils/listResponse';
import { getVendorPresetUrls, listVendorModels, listVendors } from '@/api/vendor';
import type { Vendor, VendorModel, VendorType } from '@/types/vendor';

const loading = ref(false);
const dialogLoading = ref(false);
const available = ref(true);
const unavailableReason = ref('');
const savingClient = ref<ClientName | ''>('');
const backingUpClient = ref<ClientName | ''>('');
const restoringBackupId = ref<number | null>(null);
const renamingBackupId = ref<number | null>(null);
const clients = ref<ClientConfigStatus[]>([]);
const activeClient = ref<ClientName | ''>('');
const users = ref<User[]>([]);
const models = ref<Model[]>([]);
const vendors = ref<Vendor[]>([]);
const vendorModels = ref<VendorModel[]>([]);
const vendorPresetUrls = ref<Record<string, Record<string, string>>>({});
const selectedClient = ref<ClientConfigStatus | null>(null);
const configDialogVisible = ref(false);
const renameDialogVisible = ref(false);
const detailDialogVisible = ref(false);
const detailConfig = ref<CurrentClientConfig | null>(null);
const detailClientName = ref('');
const detailConfigName = ref('');

const configForm = reactive<{
    client: ClientName | '';
    connectionMode: ClientConnectionMode;
    protocol: ClientProtocol;
    gatewayUrl: string;
    upstreamUrl: string;
    userId: number | null;
    vendorId: number | null;
    model: string;
    upstreamModel: string;
    effortLevel?: string;
}>({
    client: '',
    connectionMode: 'gateway',
    protocol: 'anthropic',
    gatewayUrl: '',
    upstreamUrl: '',
    userId: null,
    vendorId: null,
    model: '',
    upstreamModel: '',
    effortLevel: undefined,
});

const renameForm = reactive<{
    client: ClientName | '';
    backupId: number | null;
    name: string;
}>({
    client: '',
    backupId: null,
    name: '',
});

const protocolByClient: Record<ClientName, ClientProtocol> = {
    [ClientName.CLAUDE_CODE]: 'anthropic',
    [ClientName.CODEX]: 'responses',
};

const clientProtocolLabels: Record<ClientName, string> = {
    [ClientName.CLAUDE_CODE]: 'Anthropic',
    [ClientName.CODEX]: 'OpenAI Responses',
};

const enabledModels = computed(() => models.value.filter(model => model.enable));
const selectedProtocolLabel = computed(() => selectedClient.value ? clientProtocolLabels[selectedClient.value.client] : '');
const configDialogTitle = computed(() => selectedClient.value ? `配置 ${selectedClient.value.displayName}` : '配置客户端');
const detailDialogTitle = computed(() => detailConfigName.value ? `配置详情：${detailConfigName.value}` : '配置详情');

onMounted(() => {
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
            activeClient.value = firstClient.client;
        }
    } finally {
        loading.value = false;
    }
}

watch(clients, (items) => {
    if (!items.some(item => item.client === activeClient.value)) {
        activeClient.value = items[0]?.client || '';
    }
});

async function openConfigDialog(client: ClientConfigStatus): Promise<void> {
    selectedClient.value = client;
    configForm.client = client.client;
    configForm.connectionMode = 'gateway';
    configForm.protocol = protocolByClient[client.client];
    configForm.gatewayUrl = getDefaultGatewayUrl();
    configForm.upstreamUrl = '';
    configForm.userId = null;
    configForm.vendorId = null;
    configForm.model = '';
    configForm.upstreamModel = '';
    configForm.effortLevel = undefined;
    vendorModels.value = [];
    configDialogVisible.value = true;

    await loadDialogOptions();

    const activeUser = users.value.find(user => user.status === 'active');
    if (activeUser) {
        configForm.userId = activeUser.id;
    }

    const firstModel = enabledModels.value[0];
    if (firstModel) {
        configForm.model = firstModel.name;
    }

    const firstVendor = vendors.value[0];
    if (firstVendor) {
        configForm.vendorId = firstVendor.id;
        await updateVendorDefaults();
    }
}

function getDefaultGatewayUrl(): string {
    const baseUrl = getBaseURL();
    if (/^https?:\/\//.test(baseUrl)) {
        return baseUrl.replace(/\/+$/, '').replace('://localhost', '://127.0.0.1');
    }

    if (baseUrl === '/api' && import.meta.env.DEV) {
        return 'http://127.0.0.1:8720';
    }

    return window.location.origin.replace('://localhost', '://127.0.0.1');
}

async function loadDialogOptions(): Promise<void> {
    dialogLoading.value = true;
    try {
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
    } finally {
        dialogLoading.value = false;
    }
}

async function submitConfig(): Promise<void> {
    if (!configForm.client) {
        return;
    }

    const request = buildApplyRequest();
    if (!request) return;

    const target = selectedClient.value;
    if (target && target.backupCount < 1) {
        const shouldContinue = await confirmInitialBackup(target);
        if (!shouldContinue) {
            return;
        }
    }

    savingClient.value = configForm.client;
    try {
        const status = await applyClientConfig(request);
        updateClientStatus(status);
        configDialogVisible.value = false;
        message.success(`${status.displayName} 已配置`);
    } finally {
        savingClient.value = '';
    }
}

function confirmInitialBackup(client: ClientConfigStatus): Promise<boolean> {
    return new Promise((resolve) => {
        Modal.confirm({
            title: `先保存 ${client.displayName} 当前配置？`,
            content: '当前客户端还没有保存过配置。建议先保存当前配置，后续可以从已保存配置中切换回来。',
            okText: '保存并继续',
            cancelText: '暂不配置',
            async onOk() {
                try {
                    await backupCurrentConfig(client.client, false);
                    resolve(true);
                } catch (error) {
                    resolve(false);
                    throw error;
                }
            },
            onCancel() {
                resolve(false);
            },
        });
    });
}

function buildApplyRequest() {
    if (!configForm.client) return null;

    if (configForm.connectionMode === 'gateway') {
        const user = users.value.find(item => item.id === configForm.userId);
        if (!user) {
            message.error('请选择用户');
            return null;
        }

        if (!configForm.model) {
            message.error('请选择模型');
            return null;
        }

        if (!configForm.gatewayUrl.trim()) {
            message.error('请输入服务端地址');
            return null;
        }

        return {
            client: configForm.client,
            connectionMode: 'gateway' as const,
            protocol: configForm.protocol,
            gatewayUrl: configForm.gatewayUrl,
            apiKey: user.token,
            model: configForm.model,
            effortLevel: configForm.effortLevel,
        };
    }

    const vendor = vendors.value.find(item => item.id === configForm.vendorId);
    if (!vendor) {
        message.error('请选择供应商');
        return null;
    }

    if (!configForm.upstreamModel) {
        message.error('请选择供应商模型');
        return null;
    }

    if (!configForm.upstreamUrl.trim()) {
        message.error('当前供应商没有配置该协议的服务端地址');
        return null;
    }

    return {
        client: configForm.client,
        connectionMode: 'vendor' as const,
        protocol: configForm.protocol,
        gatewayUrl: configForm.upstreamUrl,
        apiKey: vendor.token,
        model: configForm.upstreamModel,
        effortLevel: configForm.effortLevel,
    };
}

function filterSelectOption(input: string, option: any): boolean {
    return String(option?.label ?? option?.children ?? '').toLowerCase().includes(input.toLowerCase());
}

async function handleConnectionModeChange(mode: string): Promise<void> {
    configForm.connectionMode = mode as ClientConnectionMode;
    if (configForm.connectionMode === 'vendor') {
        await updateVendorDefaults();
    }
}

async function handleVendorChange(): Promise<void> {
    await updateVendorDefaults();
}

async function updateVendorDefaults(): Promise<void> {
    const vendor = vendors.value.find(item => item.id === configForm.vendorId);
    if (!vendor) {
        vendorModels.value = [];
        configForm.upstreamUrl = '';
        configForm.upstreamModel = '';
        return;
    }

    configForm.upstreamUrl = getVendorUrl(vendor, configForm.protocol);
    await loadSelectedVendorModels(vendor.id);
}

async function loadSelectedVendorModels(vendorId: number): Promise<void> {
    vendorModels.value = await listVendorModels(vendorId);
    configForm.upstreamModel = vendorModels.value[0]?.model_id || '';
}

function getVendorUrl(vendor: Vendor, protocol: ClientProtocol): string {
    const presetUrls = vendorPresetUrls.value[vendor.type] || {};
    const urls = { ...presetUrls, ...vendor.urls };

    if (protocol === 'responses') {
        return urls.responses || urls.openai || '';
    }

    return urls.anthropic || '';
}

function findUser(id: number): User | undefined {
    return users.value.find(user => user.id === id);
}

function findVendorByUrl(url: string, protocol: ClientProtocol): Vendor | undefined {
    if (!url) return undefined;
    return vendors.value.find(vendor => {
        const vendorUrl = getVendorUrl(vendor, protocol);
        return vendorUrl && url.startsWith(vendorUrl);
    });
}

function findVendor(id: number): Vendor | undefined {
    return vendors.value.find(vendor => vendor.id === id);
}

function getUserTypeLabel(type?: UserType): string {
    if (type === 'admin') return '管理员';
    if (type === 'root') return 'Root';
    return '普通用户';
}

function getUserTypeColor(type?: UserType): string {
    if (type === 'admin') return 'blue';
    if (type === 'root') return 'purple';
    return 'default';
}

function getConnectionModeLabel(mode?: ClientConnectionMode): string {
    if (mode === 'gateway') return '代理模式';
    if (mode === 'vendor') return '直连模式';
    return '未配置';
}

function getConnectionModeColor(mode?: ClientConnectionMode): string {
    if (mode === 'gateway') return 'blue';
    if (mode === 'vendor') return 'green';
    return 'default';
}

function isGatewayConfig(config?: CurrentClientConfig | null): boolean {
    return config?.connectionMode === 'gateway';
}

function getProtocolLabel(protocol?: ClientProtocol): string {
    if (protocol === 'anthropic') return 'Anthropic';
    if (protocol === 'responses') return 'OpenAI Responses';
    return '';
}

function getVendorTypeLabel(type?: VendorType): string {
    if (!type) return '';
    const labels: Record<VendorType, string> = {
        aliyun: 'Aliyun (通义千问)',
        aliyun_coding: 'Aliyun Coding',
        volcengine_coding: 'Volcengine Coding',
        deepseek: 'DeepSeek',
        mimo: 'Mimo',
        mimo_token_plan: 'Mimo Token Plan',
        opencode_go: 'OpenCode Go',
        openai: 'OpenAI',
        anthropic: 'Anthropic',
        google: 'Google',
        other: 'Other',
    };
    return labels[type] || type;
}

function getVendorTypeColor(type?: VendorType): string {
    if (!type) return 'default';
    const colors: Record<VendorType, string> = {
        aliyun: 'orange',
        aliyun_coding: 'orange',
        volcengine_coding: 'purple',
        deepseek: '',
        mimo: 'blue',
        mimo_token_plan: 'blue',
        opencode_go: 'cyan',
        openai: 'green',
        anthropic: 'orange',
        google: '',
        other: 'default',
    };
    return colors[type] || 'default';
}

function getVendorTypeTagStyle(type?: VendorType) {
    if (type === 'deepseek' || type === 'google') {
        return {
            color: 'var(--accent-primary)',
            backgroundColor: 'var(--accent-primary-soft)',
            borderColor: 'var(--accent-primary-border)',
        };
    }
    return undefined;
}

function getCurrentConfigName(client: ClientConfigStatus): string {
    return client.currentConfig?.model || `${client.displayName} 配置`;
}

async function openDetailDialog(client: ClientConfigStatus, config: CurrentClientConfig | null, name: string): Promise<void> {
    await loadDialogOptions();
    detailClientName.value = client.displayName;
    detailConfigName.value = name;
    detailConfig.value = config;
    detailDialogVisible.value = true;
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
        if (selectedClient.value?.client === client) {
            selectedClient.value = target;
        }
        if (showSuccess) {
            message.success(`${target.displayName} 当前配置已保存`);
        }
    } finally {
        backingUpClient.value = '';
    }
}

function openRenameDialog(client: ClientName, backup: ClientConfigBackupInfo): void {
    renameForm.client = client;
    renameForm.backupId = backup.id;
    renameForm.name = backup.name;
    renameDialogVisible.value = true;
}

async function submitRenameConfig(): Promise<void> {
    if (!renameForm.client || !renameForm.backupId) {
        return;
    }

    const name = renameForm.name.trim();
    if (!name) {
        message.error('请输入配置名称');
        return;
    }

    renamingBackupId.value = renameForm.backupId;
    try {
        const backup = await renameClientConfigBackup({
            client: renameForm.client,
            backupId: renameForm.backupId,
            name,
        });
        updateBackupInfo(backup);
        renameDialogVisible.value = false;
        message.success('配置名称已修改');
    } finally {
        renamingBackupId.value = null;
    }
}

function restoreConfig(client: ClientName, backupId?: number): void {
    const target = clients.value.find(item => item.client === client);
    const selectedBackup = target?.backups.find(item => item.id === backupId) || target?.backups[0];
    if (!selectedBackup) {
        message.error('没有可恢复的配置');
        return;
    }

    Modal.confirm({
        title: `切换 ${target?.displayName || '客户端'} 配置？`,
        content: `将使用「${selectedBackup.name}」覆盖当前配置。`,
        okText: '切换',
        okType: 'danger',
        cancelText: '取消',
        async onOk() {
            restoringBackupId.value = selectedBackup.id;
            try {
                const status = await restoreClientConfig({ client, backupId: selectedBackup.id });
                updateClientStatus(status);
                message.success(`${status.displayName} 已切换`);
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
    if (!client || index < 0) {
        return;
    }

    client.backups[index] = backup;
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

.config-path {
    color: var(--text-secondary, #8c8c8c);
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    font-size: 12px;
    word-break: break-all;
}

.config-path-list {
    display: grid;
    gap: 4px;
    min-width: 0;
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
}

.icon-placeholder {
    width: 20px;
    height: 20px;
}

.empty-check-circle {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 1px solid #d9d9d9;
    cursor: pointer;
    background-color: #fff;
    transition: all 0.3s;
    flex-shrink: 0;
}

.empty-check-circle:hover {
    border-color: #1677ff;
}

.config-row-name {
    color: var(--text-primary);
    font-size: 14px;
    font-weight: 600;
}

.config-row-name-with-action {
    align-items: center;
    display: inline-flex;
    gap: 4px;
    min-width: 0;
}

.rename-button {
    color: var(--text-secondary, #8c8c8c);
    flex-shrink: 0;
}

.current-config-icon {
    color: #1677ff;
    font-size: 20px;
    flex-shrink: 0;
}

.config-row-content {
    display: grid;
    gap: 8px;
    min-width: 0;
}

.config-row-actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
    white-space: nowrap;
}

.config-summary-line {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.config-line {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
}

.config-label {
    color: var(--text-secondary, #8c8c8c);
    flex: 0 0 42px;
    font-size: 12px;
}

.config-muted {
    color: var(--text-secondary, #8c8c8c);
    font-size: 13px;
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

.merged-mode-tag {
    margin-right: 2px;
    border-radius: 4px;
    border-color: transparent;
}

.model-text {
    color: var(--text-primary, #262626);
    font-weight: 500;
}

.flow-arrow {
    font-size: 10px;
    color: #bfbfbf;
}

.flow-logo {
    width: 14px;
    height: 14px;
}


.client-message {
    margin-top: 8px;
    color: var(--accent-danger, #cf1322);
    font-size: 13px;
}

.empty-state {
    margin-top: 36px;
}

.config-form {
    padding-top: 8px;
}

.readonly-config-form :deep(.ant-form-item) {
    margin-bottom: 14px;
}

.readonly-field {
    align-items: center;
    background: var(--bg-layout, #f5f5f5);
    border: 1px solid var(--border-color, #d9d9d9);
    border-radius: 6px;
    display: flex;
    min-height: 32px;
    padding: 4px 11px;
}

.form-label-with-help {
    display: inline-flex;
    align-items: center;
    gap: 6px;
}

.label-help-icon {
    color: var(--text-secondary, #8c8c8c);
    cursor: help;
    font-size: 13px;
}

.select-option-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
}

.selected-option {
    line-height: 1;
}

.select-option-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.select-tag {
    margin: 0;
    flex-shrink: 0;
}

@media (max-width: 760px) {
    .client-manager {
        padding: 16px;
    }

    .config-row {
        align-items: stretch;
        grid-template-columns: 1fr;
        gap: 10px;
    }

    .config-row-actions {
        justify-content: flex-start;
    }
}
</style>
