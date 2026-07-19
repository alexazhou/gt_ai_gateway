<template>
    <a-modal
        v-model:open="visible"
        @cancel="handleCancel"
        :confirm-loading="loading"
        :width="760"
    >
        <template #title>
            <div class="modal-title">
                <span>{{ isEdit ? '编辑模型' : '新建模型' }}</span>
                <div class="model-status">
                    <span>启用</span>
                    <a-switch v-model:checked="formState.enable" size="small" />
                </div>
            </div>
        </template>
        <template #footer>
            <div class="modal-footer">
                <a-button @click="handleCancel">取消</a-button>
                <a-button type="primary" :loading="loading" @click="handleOk">
                    {{ isEdit ? '保存' : '创建' }}
                </a-button>
            </div>
        </template>
        <a-form
            :model="formState"
            :rules="rules"
            class="model-form"
            layout="horizontal"
            :colon="false"
            :label-col="{ style: { width: '128px' } }"
            :wrapper-col="{ style: { flex: 1 } }"
            ref="formRef"
        >
            <a-form-item label="模型名称" name="name">
                <a-input v-model:value="formState.name" placeholder="请输入模型名称" />
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
                <a-radio-group
                    v-model:value="formState.routing_mode"
                    class="routing-mode-selector"
                    button-style="solid"
                    @change="handleRoutingModeChange"
                >
                    <a-radio-button value="single">
                        固定上游
                        <a-tooltip title="使用唯一启用的上游">
                            <InfoCircleOutlined class="routing-help-icon" />
                        </a-tooltip>
                    </a-radio-button>
                    <a-radio-button value="load_balance">
                        负载均衡
                        <a-tooltip title="从所有可用上游中等概率选择">
                            <InfoCircleOutlined class="routing-help-icon" />
                        </a-tooltip>
                    </a-radio-button>
                    <a-radio-button value="failover">
                        故障转移
                        <a-tooltip title="按列表顺序选择，第一个不可用时自动切换到下一个">
                            <InfoCircleOutlined class="routing-help-icon" />
                        </a-tooltip>
                    </a-radio-button>
                </a-radio-group>
            </a-form-item>
            <a-form-item required>
                <template #label>
                    <span class="upstream-label">
                        上游配置
                        <a-tooltip title="配置模型请求实际使用的供应商和上游模型">
                            <InfoCircleOutlined class="field-help-icon" />
                        </a-tooltip>
                    </span>
                </template>
                <UpstreamConfig
                    v-model:upstreams="formState.upstreams"
                    mode="edit"
                    :routing-mode="formState.routing_mode"
                    :model-name="formState.name"
                />
            </a-form-item>
            <a-form-item v-if="moduleBillingEnabled" label="价格设置">
                <PriceConfig v-model:prices="formState.prices" mode="edit" />
            </a-form-item>
        </a-form>
    </a-modal>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue';
import type { FormInstance } from 'ant-design-vue/es';
import { InfoCircleOutlined } from '@ant-design/icons-vue';
import { createModel, updateModel } from '@/api/model';
import { getConfig } from '@/api/config';
import type {
    CreateModelRequest,
    Model,
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

const isEdit = ref(false);
const currentId = ref<number>(0);

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
    upstreams: [createUpstream()] as ModelUpstreamFormValue[],
    enable: true,
    prices: {
        input: undefined as number | undefined,
        output: undefined as number | undefined,
        cache_read: undefined as number | undefined,
    },
});

const rules = {
    name: [{ required: true, message: '请输入模型名称' }],
};

const moduleBillingEnabled = ref(false);

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
    isEdit.value = false;
    currentId.value = 0;
    getConfig().then(config => {
        moduleBillingEnabled.value = config.module_billing_enabled === 'true';
    });
    visible.value = true;
}

function openEdit(model: Model) {
    resetForm();
    isEdit.value = true;
    currentId.value = model.id;
    formState.name = model.name;
    formState.routing_mode = model.routing_mode;
    const upstreams = model.routing_config.upstreams;
    formState.upstreams = upstreams.map(upstream => createUpstream({
        vendor_id: upstream.vendor_id,
        vendor_model_id: upstream.vendor_model_id,
        enabled: upstream.enabled,
    }));
    formState.enable = Boolean(model.enable);
    formState.prices = {
        input: model.prices?.input || undefined,
        output: model.prices?.output || undefined,
        cache_read: model.prices?.cache_read || undefined,
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
        };
        const requestData: CreateModelRequest = {
            name: formState.name,
            enable: formState.enable,
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
    formState.upstreams = [createUpstream()];
    formState.enable = true;
    formState.prices = {
        input: undefined,
        output: undefined,
        cache_read: undefined,
    };
}

function handleCancel() {
    visible.value = false;
    isEdit.value = false;
    currentId.value = 0;
    resetForm();
}

defineExpose({ openCreate, openEdit });
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

.routing-mode-selector {
    display: flex;
    width: 100%;
}

.routing-mode-selector :deep(.ant-radio-button-wrapper) {
    flex: 1;
    text-align: center;
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
