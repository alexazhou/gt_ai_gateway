<template>
    <a-modal
        v-model:open="visible"
        @cancel="handleCancel"
        :confirm-loading="loading"
        :width="720"
    >
        <template #title>
            <div class="modal-title">
                <span>{{ isEdit ? '编辑规则' : '新增规则' }}</span>
                <div class="rule-status">
                    <span>启用</span>
                    <a-switch v-model:checked="formState.enabled" size="small" />
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
        <a-form :model="formState" layout="vertical">
            <a-form-item label="规则名称" name="name">
                <a-input v-model:value="formState.name" placeholder="例如：gpt-4o 仅内部用户可用" />
            </a-form-item>
            <a-form-item label="规则类型" name="type">
                <a-radio-group v-model:value="formState.type" button-style="solid">
                    <a-radio-button value="rate_limit">
                        限流（RPM）
                        <a-tooltip title="按 RPM 上限拒绝超限请求（429）">
                            <InfoCircleOutlined class="field-help-icon" />
                        </a-tooltip>
                    </a-radio-button>
                    <a-radio-button value="access_control">
                        访问控制
                        <a-tooltip title="条件命中即拒绝请求（403）">
                            <InfoCircleOutlined class="field-help-icon" />
                        </a-tooltip>
                    </a-radio-button>
                </a-radio-group>
            </a-form-item>

            <a-form-item label="匹配条件（scope）" required>
                <div class="scope-editor">
                    <ScopeTreeEditor :node="formState.scope" is-root />
                </div>
            </a-form-item>

            <a-form-item v-if="formState.type === 'rate_limit'" label="限流参数（config）" required>
                <div class="config-row">
                    <span class="config-label">RPM（每分钟请求数）</span>
                    <a-input-number
                        v-model:value="formState.config.rpm"
                        :min="0"
                        :precision="0"
                        placeholder="留空 = 不限制"
                        style="width: 200px"
                    />
                    <span class="config-hint">
                        0 = 不可用（全部 429）；留空 = 不限制；N = 60s 内最多 N 个请求
                    </span>
                </div>
            </a-form-item>
            <a-form-item v-else label="访问控制参数">
                <span class="config-hint">无需参数：条件命中即拒绝（403），可表达白名单（not in）等场景</span>
            </a-form-item>
        </a-form>
    </a-modal>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { InfoCircleOutlined } from '@ant-design/icons-vue';
import { createRule, updateRule } from '@/api/rule';
import ScopeTreeEditor from '@/components/rule/ScopeTreeEditor.vue';
import type { ExprNode, LeafNode, LogicNode, Rule, RuleConfig, RuleType } from '@/types/rule';
import { notifyError, notifyRequestError, notifySuccess } from '@/utils/requestFeedback';

const emit = defineEmits<{
    success: [rule: Rule];
}>();

const visible = ref(false);
const loading = ref(false);
const currentId = ref(0);
const isEdit = computed(() => currentId.value > 0);

function createDefaultScope(): ExprNode {
    return { type: 'and', values: [{ type: 'model_id', oper: '=', values: [] } as LeafNode] } as LogicNode;
}

const formState = reactive({
    name: '',
    type: 'rate_limit' as RuleType,
    scope: createDefaultScope() as ExprNode,
    config: { rpm: null as number | null },
    enabled: true,
});

function openCreate(): void {
    resetForm();
    currentId.value = 0;
    visible.value = true;
}

function openEdit(rule: Rule): void {
    resetForm();
    currentId.value = rule.id;
    formState.name = rule.name;
    formState.type = rule.type;
    formState.scope = structuredClone(rule.scope) as ExprNode;
    formState.enabled = Boolean(rule.enabled);
    if (rule.type === 'rate_limit') {
        const rpm = (rule.config as { rpm?: number | null }).rpm;
        formState.config.rpm = rpm ?? null;
    } else {
        formState.config.rpm = null;
    }
    visible.value = true;
}

// type 切换时重置 config
watch(() => formState.type, () => {
    if (formState.type === 'access_control') {
        formState.config.rpm = null;
    }
});

function resetForm(): void {
    formState.name = '';
    formState.type = 'rate_limit';
    formState.scope = createDefaultScope();
    formState.config.rpm = null;
    formState.enabled = true;
}

async function handleOk(): Promise<void> {
    if (!formState.name.trim()) {
        notifyError('请输入规则名称');
        return;
    }

    const config: RuleConfig = formState.type === 'rate_limit'
        ? { rpm: formState.config.rpm }
        : {};

    const requestData = {
        type: formState.type,
        name: formState.name.trim(),
        scope: formState.scope,
        config,
        enabled: formState.enabled,
    };

    loading.value = true;
    try {
        const rule = isEdit.value
            ? await updateRule(currentId.value, requestData)
            : await createRule(requestData);
        notifySuccess(isEdit.value ? '更新成功' : '创建成功');
        emit('success', rule);
        handleCancel();
    } catch (error) {
        notifyRequestError(error, isEdit.value ? '更新失败' : '创建失败');
    } finally {
        loading.value = false;
    }
}

function handleCancel(): void {
    visible.value = false;
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

.rule-status {
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

.field-help-icon {
    margin-left: 4px;
    color: var(--text-secondary);
    font-size: 12px;
}

.scope-editor {
    padding: 12px;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    background: var(--bg-page);
}

.config-row {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
}

.config-label {
    font-size: 14px;
}

.config-hint {
    color: var(--text-secondary);
    font-size: 12px;
}
</style>
