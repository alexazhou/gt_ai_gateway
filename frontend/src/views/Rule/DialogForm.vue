<template>
    <a-modal
        v-model:open="visible"
        @cancel="handleCancel"
        :confirm-loading="loading"
        :width="720"
        :body-style="{ paddingTop: '16px' }"
    >
        <template #title>
            <div class="modal-title">
                <span>{{ modalTitle }}</span>
                <div class="rule-status">
                    <span>启用</span>
                    <a-switch v-model:checked="formState.enabled" size="small" :disabled="viewMode" />
                    <template v-if="tenantStore.multiTenantEnabled">
                        <a-tooltip title="跨租户共享仅 main 租户规则可开启；开启后对所有租户生效（非 main 租户规则不可勾选）">
                            <span style="margin-left: 12px;">跨租户共享</span>
                        </a-tooltip>
                        <a-switch v-model:checked="formState.cross_tenant" size="small" :disabled="!isMainView || viewMode" />
                    </template>
                </div>
            </div>
        </template>
        <template #footer>
            <div class="modal-footer">
                <template v-if="viewMode">
                    <a-button type="primary" @click="handleCancel">关闭</a-button>
                </template>
                <template v-else>
                    <a-button @click="handleCancel">取消</a-button>
                    <a-button type="primary" :loading="loading" @click="handleOk">
                        {{ isEdit ? '保存' : '创建' }}
                    </a-button>
                </template>
            </div>
        </template>
        <a-form :model="formState" layout="vertical" class="rule-form">
            <a-form-item label="规则名称" name="name">
                <a-input v-model:value="formState.name" placeholder="例如：gpt-4o 仅内部用户可用" :disabled="viewMode" />
            </a-form-item>
            <a-form-item label="备注" name="note">
                <a-textarea
                    v-model:value="formState.note"
                    :auto-size="{ minRows: 2, maxRows: 6 }"
                    :maxlength="NOTE_MAX_LENGTH"
                    show-count
                    :disabled="viewMode"
                    placeholder="选填：这条规则要解决什么问题、谁提的需求"
                />
            </a-form-item>
            <a-form-item label="规则类型" name="type">
                <a-radio-group v-model:value="formState.type" button-style="solid" :disabled="viewMode">
                    <a-radio-button value="rate_limit">
                        限流（RPM）
                        <a-tooltip title="按 RPM 上限拒绝超限请求（429）">
                            <InfoCircleOutlined class="field-help-icon" />
                        </a-tooltip>
                    </a-radio-button>
                    <a-radio-button value="forbid_access">
                        禁止访问
                        <a-tooltip title="条件命中即拒绝请求（403）">
                            <InfoCircleOutlined class="field-help-icon" />
                        </a-tooltip>
                    </a-radio-button>
                    <a-radio-button value="plugin">
                        请求插件
                        <a-tooltip title="条件命中时对转发前的请求体 / 请求头做改写（仅能改非受保护字段）">
                            <InfoCircleOutlined class="field-help-icon" />
                        </a-tooltip>
                    </a-radio-button>
                </a-radio-group>
            </a-form-item>
            <a-form-item label="优先级" name="priority">
                <div class="config-row">
                    <a-input-number
                        v-model:value="formState.priority"
                        :min="0"
                        :max="10000"
                        :precision="0"
                        :disabled="viewMode"
                        style="width: 160px"
                    />
                    <span class="config-hint">
                        数值越小越先执行（0 ~ 10000，默认 100）；插件按此顺序依次改写，同一字段后执行的生效
                    </span>
                </div>
            </a-form-item>

            <a-form-item label="匹配条件（scope）" required class="scope-form-item">
                <div class="scope-editor">
                    <ScopeTreeEditor :node="formState.scope" :options="scopeOptions" :readonly="viewMode" is-root />
                </div>
            </a-form-item>

            <a-form-item v-if="formState.type === 'rate_limit'" label="限流参数（config）" required>
                <div class="config-row">
                    <span class="config-label">RPM（每分钟请求数）</span>
                    <a-input-number
                        v-model:value="formState.config.rpm"
                        :min="0"
                        :precision="0"
                        :disabled="viewMode"
                        placeholder="留空 = 不限制"
                        style="width: 200px"
                    />
                    <span class="config-hint">
                        0 = 不可用（全部 429）；留空 = 不限制；N = 60s 内最多 N 个请求
                    </span>
                </div>
            </a-form-item>
            <template v-else-if="formState.type === 'plugin'">
                <a-form-item label="请求插件" required>
                    <div class="config-row">
                        <a-select
                            v-model:value="formState.pluginName"
                            :options="pluginOptions"
                            :loading="pluginsLoading"
                            :disabled="viewMode"
                            placeholder="选择插件"
                            style="width: 260px"
                            @change="handlePluginChange"
                        />
                        <span class="config-hint">{{ currentPluginHint }}</span>
                    </div>
                </a-form-item>
                <a-form-item label="插件参数（JSON）">
                    <a-textarea
                        v-model:value="formState.pluginConfigText"
                        :rows="6"
                        :disabled="viewMode"
                        placeholder='留空即 {}；例如 {"cchValue": "A1234"}'
                        class="plugin-config-textarea"
                    />
                    <span class="config-hint">
                        格式仅在前端校验 JSON 合法性，参数含义与取值范围由后端 / 插件自身校验
                    </span>
                </a-form-item>
            </template>
            <a-form-item v-else label="禁止访问参数">
                <span class="config-hint">无需参数：条件命中即拒绝（403），可表达白名单（not in）等场景</span>
            </a-form-item>
        </a-form>
    </a-modal>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { InfoCircleOutlined } from '@ant-design/icons-vue';
import { createRule, listPlugins, updateRule } from '@/api/rule';
import { useTenantStore } from '@/stores/tenant';
import { listModels } from '@/api/model';
import { listUsers } from '@/api/user';
import { listVendors } from '@/api/vendor';
import ScopeTreeEditor from '@/components/rule/ScopeTreeEditor.vue';
import { normalizeListResponse } from '@/utils/listResponse';
import type {
    ExprNode,
    LeafNode,
    LogicNode,
    PluginDescriptor,
    PluginRuleConfig,
    Rule,
    RuleConfig,
    RuleType,
    ScopeOptions,
} from '@/types/rule';
import { notifyError, notifyRequestError, notifySuccess } from '@/utils/requestFeedback';

const emit = defineEmits<{
    success: [rule: Rule];
}>();

const DEFAULT_PRIORITY = 100;
// 与后端 src/constants.ts 的 RULE_NOTE_MAX_LENGTH 一致，超长后端返回 400
const NOTE_MAX_LENGTH = 500;

const visible = ref(false);
const loading = ref(false);
const currentId = ref(0);
const isEdit = computed(() => currentId.value > 0);
// 只读查看（系统规则）：回填同样的内容，禁用全部输入，footer 只留关闭
const viewMode = ref(false);
const modalTitle = computed(() => {
    if (viewMode.value) return '查看规则';
    return isEdit.value ? '编辑规则' : '新增规则';
});

function createDefaultScope(): ExprNode {
    return { type: 'and', values: [{ type: 'model_id', oper: '=', values: [] } as LeafNode] } as LogicNode;
}

const formState = reactive({
    name: '',
    note: '',
    type: 'rate_limit' as RuleType,
    priority: DEFAULT_PRIORITY,
    scope: createDefaultScope() as ExprNode,
    config: { rpm: null as number | null },
    pluginName: '',
    pluginConfigText: '',
    enabled: true,
    cross_tenant: false,
});

const tenantStore = useTenantStore();
const isMainView = computed(() => tenantStore.isMainView);

// 条件树叶子下拉选项（模型 / 用户 / 供应商）
const scopeOptions = ref<ScopeOptions>({ models: [], users: [], vendors: [] });

async function loadScopeOptions(): Promise<void> {
    try {
        const [models, users, vendors] = await Promise.all([
            listModels({ page: 1, pageSize: 1000 }),
            listUsers({ page: 1, pageSize: 1000 }),
            listVendors({ page: 1, pageSize: 1000 }),
        ]);
        scopeOptions.value = {
            models: normalizeListResponse(models).list.map(item => ({ id: item.id, name: item.name })),
            users: normalizeListResponse(users).list.map(item => ({ id: item.id, name: item.name })),
            vendors: normalizeListResponse(vendors).list.map(item => ({ id: item.id, name: item.name })),
        };
    } catch (e) {
        // 选项加载失败不阻塞编辑：叶子退回文本输入（可手填 ID）
        console.error('[RuleDialog] Failed to load scope options:', e);
    }
}

// 可用请求插件（后端插件注册表）
const plugins = ref<PluginDescriptor[]>([]);
const pluginsLoading = ref(false);
const pluginOptions = computed(() => plugins.value.map(plugin => ({
    value: plugin.name,
    label: plugin.description ? `${plugin.name}（${plugin.description}）` : plugin.name,
})));

const currentPlugin = computed<PluginDescriptor | undefined>(
    () => plugins.value.find(plugin => plugin.name === formState.pluginName),
);
const currentPluginHint = computed(() => {
    const plugin = currentPlugin.value;
    if (!plugin) {
        return '插件清单来自网关插件注册表';
    }
    const hooks = plugin.hooks.length > 0 ? plugin.hooks.join(' / ') : '—';
    return `执行钩子：${hooks}`;
});

async function loadPlugins(): Promise<void> {
    if (plugins.value.length > 0 || pluginsLoading.value) {
        return;
    }
    pluginsLoading.value = true;
    try {
        const result = await listPlugins();
        // 后端返回数组；个别代理会包装成 {data: [...]}，两种都兼容
        const list = Array.isArray(result) ? result : ((result as unknown as { data?: PluginDescriptor[] }).data ?? []);
        plugins.value = list;
    } catch (e) {
        console.error('[RuleDialog] Failed to load plugins:', e);
    } finally {
        pluginsLoading.value = false;
    }
}

/** 选中插件后若参数还是空的，用插件自带的 configExample 作起始值 */
function handlePluginChange(): void {
    const plugin = currentPlugin.value;
    if (!plugin) {
        return;
    }
    if (formState.pluginConfigText.trim() !== '') {
        return;
    }
    if (plugin.configExample && Object.keys(plugin.configExample).length > 0) {
        formState.pluginConfigText = JSON.stringify(plugin.configExample, null, 2);
    }
}

function openCreate(): void {
    resetForm();
    currentId.value = 0;
    viewMode.value = false;
    void loadScopeOptions();
    void loadPlugins();
    visible.value = true;
}

function openEdit(rule: Rule): void {
    fillForm(rule);
    viewMode.value = false;
    visible.value = true;
}

function openView(rule: Rule): void {
    fillForm(rule);
    viewMode.value = true;
    visible.value = true;
}

/** 编辑 / 查看共用回填：openEdit 与 openView 只差 viewMode */
function fillForm(rule: Rule): void {
    resetForm();
    currentId.value = rule.id;
    formState.name = rule.name;
    formState.note = rule.note ?? '';
    formState.type = rule.type;
    formState.priority = typeof rule.priority === 'number' ? rule.priority : DEFAULT_PRIORITY;
    // 列表数据的 scope 是 Vue 响应式 Proxy，structuredClone 无法克隆；JSON 深拷贝即可
    formState.scope = JSON.parse(JSON.stringify(rule.scope)) as ExprNode;
    formState.enabled = Boolean(rule.enabled);
    formState.cross_tenant = Boolean(rule.cross_tenant);
    if (rule.type === 'rate_limit') {
        const rpm = (rule.config as { rpm?: number | null }).rpm;
        formState.config.rpm = rpm ?? null;
    } else {
        formState.config.rpm = null;
    }
    if (rule.type === 'plugin') {
        const config = rule.config as PluginRuleConfig;
        formState.pluginName = config.plugin ?? '';
        formState.pluginConfigText = config.pluginConfig
            ? JSON.stringify(config.pluginConfig, null, 2)
            : '';
        void loadPlugins();
    }
    void loadScopeOptions();
}

// type 切换时重置 config / 插件参数
watch(() => formState.type, () => {
    if (formState.type !== 'rate_limit') {
        formState.config.rpm = null;
    }
    if (formState.type === 'plugin') {
        void loadPlugins();
        // 未选插件时默认取第一个，避免提交空插件名
        const firstPlugin = plugins.value[0];
        if (!formState.pluginName && firstPlugin) {
            formState.pluginName = firstPlugin.name;
            handlePluginChange();
        }
    }
});

function resetForm(): void {
    formState.name = '';
    formState.note = '';
    formState.type = 'rate_limit';
    formState.priority = DEFAULT_PRIORITY;
    formState.scope = createDefaultScope();
    formState.config.rpm = null;
    formState.pluginName = '';
    formState.pluginConfigText = '';
    formState.enabled = true;
    formState.cross_tenant = false;
}

/** 解析插件参数 JSON：空文本视为 {}，非对象 / 非法 JSON 返回 null */
function parsePluginConfig(text: string): Record<string, unknown> | null {
    const trimmed = text.trim();
    if (trimmed === '') {
        return {};
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return null;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
    }
    return parsed as Record<string, unknown>;
}

async function handleOk(): Promise<void> {
    if (!formState.name.trim()) {
        notifyError('请输入规则名称');
        return;
    }

    let config: RuleConfig;
    if (formState.type === 'rate_limit') {
        config = { rpm: formState.config.rpm };
    } else if (formState.type === 'plugin') {
        if (!formState.pluginName) {
            notifyError('请选择请求插件');
            return;
        }
        const pluginConfig = parsePluginConfig(formState.pluginConfigText);
        if (pluginConfig === null) {
            notifyError('插件参数必须是合法的 JSON 对象');
            return;
        }
        config = { plugin: formState.pluginName, pluginConfig } as PluginRuleConfig;
    } else {
        config = {};
    }

    const requestData = {
        type: formState.type,
        name: formState.name.trim(),
        note: formState.note.trim() || null,
        priority: formState.priority ?? DEFAULT_PRIORITY,
        scope: formState.scope,
        config,
        enabled: formState.enabled,
        cross_tenant: formState.cross_tenant,
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
    viewMode.value = false;
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
    padding: 6px 8px;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    background: var(--bg-page);
}

/* 弹窗内表单收紧行距：antd 默认 24px 在 720px 宽的弹窗里显得空 */
.rule-form :deep(.ant-form-item) {
    margin-bottom: 12px;
}

/* 条件树是带边框的块，外框底边已形成视觉间隔，再叠 12px 行距就空了 */
.rule-form :deep(.ant-form-item.scope-form-item) {
    margin-bottom: 8px;
}

.rule-form :deep(.ant-form-item-label) {
    padding-bottom: 2px;
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

.plugin-config-textarea {
    font-family: var(--font-mono, monospace);
}
</style>
