<template>
    <a-modal
        v-model:open="visible"
        @cancel="handleCancel"
        :confirm-loading="loading"
        :width="760"
    >
        <template #title>
            <div class="modal-title">
                <span>{{ dialogTitle }}</span>
                <div class="model-status">
                    <span>启用</span>
                    <a-switch v-model:checked="formState.enable" size="small" :disabled="isView" />
                    <template v-if="tenantStore.multiTenantEnabled">
                        <a-tooltip title="跨租户共享仅 main 租户模型可开启；开启后所有租户均可调用（非 main 租户模型不可勾选）">
                            <span style="margin-left: 12px;">跨租户共享</span>
                        </a-tooltip>
                        <a-switch v-model:checked="formState.cross_tenant" size="small" :disabled="isView || !isMainView" />
                    </template>
                </div>
            </div>
        </template>
        <template #footer>
            <div class="modal-footer">
                <a-button @click="handleCancel">{{ isView ? '关闭' : '取消' }}</a-button>
                <a-button v-if="!isView" type="primary" :loading="loading" @click="handleOk">
                    {{ isEdit ? '保存' : '创建' }}
                </a-button>
            </div>
        </template>
        <a-form
            :model="formState"
            :rules="isView ? {} : rules"
            class="model-form"
            layout="horizontal"
            :colon="false"
            :label-col="{ style: { width: '128px' } }"
            :wrapper-col="{ style: { flex: 1 } }"
            ref="formRef"
        >
            <a-form-item name="name">
                <template #label>
                    <span class="upstream-label">
                        模型名称
                        <a-tooltip title="客户端请求时使用的模型名称">
                            <InfoCircleOutlined class="field-help-icon" />
                        </a-tooltip>
                    </span>
                </template>
                <a-input v-model:value="formState.name" placeholder="请输入模型名称" :disabled="isView" />
            </a-form-item>
            <a-form-item name="routing_mode">
                <template #label>
                    <span class="upstream-label">
                        路由模式
                        <a-tooltip title="决定模型请求在多个上游之间的调度方式">
                            <InfoCircleOutlined class="field-help-icon" />
                        </a-tooltip>
                    </span>
                </template>
                <a-select
                    v-model:value="formState.routing_mode"
                    placeholder="请选择路由模式"
                    :disabled="isView"
                    @change="handleRoutingModeChange"
                >
                    <a-select-option value="single">
                        固定上游
                        <a-tooltip title="使用唯一启用的上游">
                            <InfoCircleOutlined class="routing-help-icon" />
                        </a-tooltip>
                    </a-select-option>
                    <a-select-option value="load_balance">
                        负载均衡
                        <a-tooltip title="在多个可用上游之间分配请求">
                            <InfoCircleOutlined class="routing-help-icon" />
                        </a-tooltip>
                    </a-select-option>
                    <a-select-option value="first_available">
                        首选可用
                        <a-tooltip title="按列表顺序选择，第一个不可用时自动切换到下一个">
                            <InfoCircleOutlined class="routing-help-icon" />
                        </a-tooltip>
                    </a-select-option>
                </a-select>
            </a-form-item>
            <a-form-item v-if="formState.routing_mode === 'load_balance'" name="load_balance_strategy">
                <template #label>
                    <span class="upstream-label">
                        随机方式
                        <a-tooltip title="按用户随机：同一用户的请求路由稳定，不同用户分散到不同上游；按请求随机：每次请求等概率随机">
                            <InfoCircleOutlined class="field-help-icon" />
                        </a-tooltip>
                    </span>
                </template>
                <a-radio-group
                    v-model:value="formState.load_balance_strategy"
                    button-style="solid"
                    :disabled="isView"
                >
                    <a-radio-button value="user">
                        按用户随机
                        <a-tooltip title="以用户 id 为种子：同一用户的请求始终路由到同一批上游（粘性），不同用户分散到不同上游">
                            <InfoCircleOutlined class="routing-help-icon" />
                        </a-tooltip>
                    </a-radio-button>
                    <a-radio-button value="request">
                        按请求随机
                        <a-tooltip title="每次请求等概率随机选择一个可用上游">
                            <InfoCircleOutlined class="routing-help-icon" />
                        </a-tooltip>
                    </a-radio-button>
                </a-radio-group>
            </a-form-item>
            <a-form-item :required="!isView">
                <template #label>
                    <span class="upstream-label">
                        上游模型
                        <a-tooltip title="配置模型请求实际使用的供应商和上游模型">
                            <InfoCircleOutlined class="field-help-icon" />
                        </a-tooltip>
                    </span>
                </template>
                <UpstreamConfig
                    :upstreams="formState.upstreams"
                    :mode="isView ? 'view' : 'edit'"
                    :routing-mode="formState.routing_mode"
                    :model-name="formState.name"
                    @update:upstreams="formState.upstreams = $event"
                />
            </a-form-item>
            <a-form-item v-if="formState.routing_mode !== 'single'" name="failover_enabled">
                <template #label>
                    <span class="upstream-label">
                        失败切换
                        <a-tooltip title="上游返回可重试错误时，自动切换到下一个可用上游">
                            <InfoCircleOutlined class="field-help-icon" />
                        </a-tooltip>
                    </span>
                </template>
                <a-switch
                    v-model:checked="formState.failoverEnabled"
                    :disabled="isView"
                />
            </a-form-item>
            <a-form-item v-if="moduleBillingEnabled" label="价格设置">
                <PriceConfig
                    :prices="formState.prices"
                    :mode="isView ? 'view' : 'edit'"
                    @update:prices="formState.prices = $event"
                />
            </a-form-item>
        </a-form>
    </a-modal>
</template>

<script setup lang="ts">
import { computed, ref, reactive } from 'vue';
import type { FormInstance } from 'ant-design-vue/es';
import { InfoCircleOutlined } from '@ant-design/icons-vue';
import { createModel, updateModel } from '@/api/model';
import { getConfig } from '@/api/config';
import { useTenantStore } from '@/stores/tenant';
import type {
    CreateModelRequest,
    LoadBalanceStrategy,
    Model,
    ModelPrices,
    ModelRoutingMode,
    ModelRoutingConfig,
    ModelUpstreamFormValue,
} from '@/types/model';
import { notifyError, notifyRequestError, notifySuccess } from '@/utils/requestFeedback';
import PriceConfig from './PriceConfig.vue';
import UpstreamConfig from './UpstreamConfig.vue';

const emit = defineEmits<{
    success: [model: Model];
}>();

const visible = ref(false);
const loading = ref(false);
const formRef = ref<FormInstance>();

const dialogMode = ref<'create' | 'edit' | 'view'>('create');
const currentId = ref<number>(0);

const isEdit = computed(() => dialogMode.value === 'edit');
const isView = computed(() => dialogMode.value === 'view');
const dialogTitle = computed(() => ({
    create: '新建模型',
    edit: '编辑模型',
    view: '查看模型',
}[dialogMode.value]));

function createUpstream(data?: Partial<ModelUpstreamFormValue>): ModelUpstreamFormValue {
    return {
        vendor_id: data?.vendor_id,
        vendor_model_id: data?.vendor_model_id,
        enabled: data?.enabled ?? true,
    };
}

const formState = reactive({
    name: '',
    routing_mode: 'single' as ModelRoutingMode,
    load_balance_strategy: 'user' as LoadBalanceStrategy,
    upstreams: [createUpstream()] as ModelUpstreamFormValue[],
    failoverEnabled: true,
    enable: true,
    cross_tenant: false,
    prices: {
        input: undefined as number | undefined,
        output: undefined as number | undefined,
        cache_read: undefined as number | undefined,
    } as ModelPrices,
});

const rules = {
    name: [{ required: true, message: '请输入模型名称' }],
};

const moduleBillingEnabled = ref(false);

// 跨租户共享仅 main 视角可勾选（以后端校验为准，前端按视角禁用）
const tenantStore = useTenantStore();
const isMainView = computed(() => tenantStore.isMainView);

function handleRoutingModeChange() {
    if (formState.routing_mode !== 'single') {
        return;
    }

    const upstream = formState.upstreams.find(item => item.enabled)
        ?? formState.upstreams[0]
        ?? createUpstream();
    upstream.enabled = true;
    formState.upstreams = [upstream];
}

function openCreate() {
    resetForm();
    dialogMode.value = 'create';
    currentId.value = 0;
    getConfig().then(config => {
        moduleBillingEnabled.value = config.module_billing_enabled === 'true';
    });
    visible.value = true;
}

function openEdit(model: Model) {
    openModel(model, 'edit');
}


function openView(model: Model) {
    openModel(model, 'view');
}


function openModel(model: Model, mode: 'edit' | 'view') {
    resetForm();
    dialogMode.value = mode;
    currentId.value = model.id;
    formState.name = model.name;
    formState.routing_mode = model.routing_mode;
    formState.load_balance_strategy = model.routing_config.load_balance_strategy ?? 'user';
    const upstreams = model.routing_config.upstreams;
    formState.upstreams = upstreams.map(upstream => createUpstream({
        vendor_id: upstream.vendor_id,
        vendor_model_id: upstream.vendor_model_id,
        enabled: upstream.enabled,
    }));
    formState.enable = Boolean(model.enable);
    formState.cross_tenant = Boolean(model.cross_tenant);
    formState.failoverEnabled = model.routing_config.failover?.enabled ?? true;
    formState.prices = {
        input: model.prices?.input ?? undefined,
        output: model.prices?.output ?? undefined,
        cache_read: model.prices?.cache_read ?? undefined,
    };
    getConfig().then(config => {
        moduleBillingEnabled.value = config.module_billing_enabled === 'true';
    });
    visible.value = true;
}

async function handleOk() {
    try {
        await formRef.value?.validate();
        if (formState.upstreams.some(upstream => !upstream.vendor_id)) {
            notifyError('请为每个上游选择供应商');
            return;
        }

        const enabledCount = formState.upstreams.filter(upstream => upstream.enabled).length;
        if (enabledCount === 0) {
            notifyError('至少需要启用一个上游');
            return;
        }
        if (formState.routing_mode === 'single' && enabledCount !== 1) {
            notifyError('固定上游模式只能启用一个上游');
            return;
        }

        loading.value = true;
        const routingConfig: ModelRoutingConfig = {
            upstreams: formState.upstreams.map(upstream => ({
                vendor_id: upstream.vendor_id!,
                ...(upstream.vendor_model_id ? { vendor_model_id: upstream.vendor_model_id } : {}),
                enabled: upstream.enabled,
            })),
            failover: { enabled: formState.failoverEnabled },
            ...(formState.routing_mode === 'load_balance'
                ? { load_balance_strategy: formState.load_balance_strategy }
                : {}),
        };
        const requestData: CreateModelRequest = {
            name: formState.name,
            enable: formState.enable,
            cross_tenant: formState.cross_tenant,
            routing_mode: formState.routing_mode,
            routing_config: routingConfig,
            prices: {
                input: formState.prices.input ?? undefined,
                output: formState.prices.output ?? undefined,
                cache_read: formState.prices.cache_read ?? undefined,
            },
        };

        if (isEdit.value) {
            const model = await updateModel(currentId.value, requestData);
            notifySuccess('更新成功');
            emit('success', model);
        } else {
            const model = await createModel(requestData);
            notifySuccess('创建成功');
            emit('success', model);
        }
        handleCancel();
    } catch (error) {
        notifyRequestError(error, isEdit.value ? '更新失败' : '创建失败');
    } finally {
        loading.value = false;
    }
}

function resetForm() {
    formState.name = '';
    formState.routing_mode = 'single';
    formState.load_balance_strategy = 'user';
    formState.upstreams = [createUpstream()];
    formState.failoverEnabled = true;
    formState.enable = true;
    formState.cross_tenant = false;
    formState.prices = {
        input: undefined,
        output: undefined,
        cache_read: undefined,
    };
}

function handleCancel() {
    visible.value = false;
    dialogMode.value = 'create';
    currentId.value = 0;
    resetForm();
}

defineExpose({ openCreate, openEdit, openView });
</script>

<style scoped>
.modal-title {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-right: 56px;
}

.model-status {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    font-weight: normal;
}

.modal-footer {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 8px;
}

.model-form {
    padding-top: 12px;
}

.routing-help-icon {
    margin-left: 4px;
    font-size: 12px;
}

.upstream-label {
    display: inline-flex;
    align-items: center;
    gap: 5px;
}

.field-help-icon {
    color: var(--text-secondary);
    font-size: 13px;
}

</style>
