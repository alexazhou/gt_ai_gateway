<template>
    <div class="rule-list">
        <div class="table-header">
            <a-form layout="inline">
                <a-form-item label="规则名称">
                    <a-input
                        v-model:value="searchForm.keyword"
                        placeholder="搜索规则名称"
                        allow-clear
                    />
                </a-form-item>
                <a-form-item>
                    <a-space>
                        <a-button type="primary" @click="handleSearch">搜索</a-button>
                        <a-button @click="handleReset">重置</a-button>
                    </a-space>
                </a-form-item>
            </a-form>
            <a-button type="primary" @click="handleCreate">新增规则</a-button>
        </div>

        <a-table
            :columns="columns"
            :data-source="data"
            :loading="loading"
            :pagination="pagination"
            @change="handleTableChange"
            :row-key="(record: Rule) => record.id"
        >
            <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'type'">
                    <a-tag :color="typeTagColor(record.type)">{{ typeLabel(record.type) }}</a-tag>
                </template>
                <template v-if="column.key === 'priority'">
                    {{ record.priority }}
                </template>
                <template v-if="column.key === 'scope'">
                    <ScopeTreeView :scope="record.scope" :options="scopeOptions" />
                </template>
                <template v-if="column.key === 'config'">
                    <span>{{ configSummary(record) }}</span>
                </template>
                <template v-if="column.key === 'enabled'">
                    <a-space :size="4">
                        <a-tag :color="Boolean(record.enabled) ? 'green' : 'red'">
                            {{ Boolean(record.enabled) ? '启用' : '停用' }}
                        </a-tag>
                        <a-tag v-if="isSharedRule(record)" color="purple">共享</a-tag>
                    </a-space>
                </template>
                <template v-if="column.key === 'created_at'">
                    {{ formatDate(record.created_at) }}
                </template>
                <template v-if="column.key === 'action'">
                    <a-space :size="0">
                        <a-tooltip title="编辑">
                            <a-button
                                type="text"
                                size="small"
                                class="rule-action-button"
                                aria-label="编辑"
                                :disabled="isSharedRule(record)"
                                @click="handleEdit(record)"
                            >
                                <EditOutlined />
                            </a-button>
                        </a-tooltip>
                        <a-tooltip title="删除">
                            <a-button
                                danger
                                type="text"
                                size="small"
                                aria-label="删除"
                                :disabled="isSharedRule(record)"
                                @click="handleDelete(record)"
                            >
                                <DeleteOutlined />
                            </a-button>
                        </a-tooltip>
                    </a-space>
                </template>
            </template>
        </a-table>

        <div class="system-rule-section">
            <div class="system-rule-header">
                <div class="system-rule-title">
                    <span>系统规则</span>
                    <a-tooltip :title="systemRuleHint">
                        <InfoCircleOutlined class="field-help-icon" />
                    </a-tooltip>
                </div>
                <a-button type="link" size="small" :loading="systemLoading" @click="loadSystemRules">
                    刷新
                </a-button>
            </div>
            <a-alert
                v-if="!isMainView"
                type="info"
                show-icon
                banner
                class="system-rule-alert"
                message="系统规则由系统管理员在主租户统一配置；当前视角下只读"
            />
            <a-table
                :columns="systemColumns"
                :data-source="systemRules"
                :loading="systemLoading"
                :pagination="false"
                :row-key="(record: Rule) => record.id"
                size="small"
            >
                <template #bodyCell="{ column, record }">
                    <template v-if="column.key === 'type'">
                        <a-tag :color="typeTagColor(record.type)">{{ typeLabel(record.type) }}</a-tag>
                    </template>
                    <template v-if="column.key === 'priority'">
                        {{ record.priority }}
                    </template>
                    <template v-if="column.key === 'scope'">
                        <ScopeTreeView :scope="record.scope" :options="scopeOptions" />
                    </template>
                    <template v-if="column.key === 'config'">
                        <span>{{ configSummary(record) }}</span>
                    </template>
                    <template v-if="column.key === 'enabled'">
                        <a-space :size="4">
                            <a-tag :color="Boolean(record.enabled) ? 'green' : 'red'">
                                {{ Boolean(record.enabled) ? '启用' : '停用' }}
                            </a-tag>
                            <a-tag v-if="isSharedRule(record)" color="purple">共享</a-tag>
                        </a-space>
                    </template>
                    <template v-if="column.key === 'edit_hint'">
                        <span class="config-hint">请前往 高级设置 → 请求处理 修改</span>
                    </template>
                </template>
            </a-table>
        </div>
    </div>

    <DialogForm ref="dialogFormRef" @success="handleSuccess" />
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { TableColumnsType } from 'ant-design-vue';
import { Modal } from 'ant-design-vue/es';
import { DeleteOutlined, EditOutlined, InfoCircleOutlined } from '@ant-design/icons-vue';
import { deleteRule, listRules } from '@/api/rule';
import { listModels } from '@/api/model';
import { listUsers } from '@/api/user';
import { listVendors } from '@/api/vendor';
import { useResourceTable } from '@/composables/useResourceTable';
import { useTenantStore } from '@/stores/tenant';
import { useAppStore } from '@/stores/app';
import { formatDate } from '@/utils/format';
import { normalizeListResponse } from '@/utils/listResponse';
import ScopeTreeView from '@/components/rule/ScopeTreeView.vue';
import DialogForm from './DialogForm.vue';
import type { Rule, RuleQuery, RuleType, ScopeOptions } from '@/types/rule';
import { notifyRequestError, notifySuccess } from '@/utils/requestFeedback';

const tenantStore = useTenantStore();
const appStore = useAppStore();

// 当前视角租户 id（root 取切换的视角；admin 取自身租户；root 未切换时缺省 main）
const myTenantId = computed(() => tenantStore.currentTenantIdNum ?? appStore.tenantId ?? appStore.mainTenantId);
const isMainView = computed(() => tenantStore.isMainView);

// 共享规则识别：main 租户规则 cross_tenant=1，且不属于当前视角租户 → 只读
function isSharedRule(record: Rule): boolean {
    return Boolean(record.cross_tenant)
        && typeof record.tenant_id === 'number'
        && myTenantId.value !== null
        && record.tenant_id !== myTenantId.value;
}

// 用户规则区：固定 source=user，与服务端默认口径一致（系统规则不在此处出现）
const { loading, data, pagination, searchForm, loadData, handleSearch, handleReset, handleTableChange } = useResourceTable<Rule, RuleQuery>({
    initialSearchForm: {
        keyword: undefined,
    },
    fetcher: (query: RuleQuery) => listRules({ ...query, source: 'user' }),
    resetSearchForm: (form) => {
        form.keyword = undefined;
    },
});

const dialogFormRef = ref<InstanceType<typeof DialogForm>>();
const scopeOptions = ref<ScopeOptions>({ models: [], users: [], vendors: [] });

// 系统规则区：只读清单，开关统一在「高级设置 → 请求处理」里控制
const systemRules = ref<Rule[]>([]);
const systemLoading = ref(false);
const systemRuleHint = '系统规则由产品预置：名称 / 匹配条件 / 参数不可修改，启用状态请在「高级设置 → 请求处理」中调整';

async function loadSystemRules(): Promise<void> {
    systemLoading.value = true;
    try {
        const result = await listRules({ page: 1, pageSize: 100, source: 'system' });
        systemRules.value = normalizeListResponse(result).list;
    } catch (e) {
        console.error('[RuleList] Failed to load system rules:', e);
    } finally {
        systemLoading.value = false;
    }
}

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
        console.error('[RuleList] Failed to load scope options:', e);
    }
}

onMounted(() => {
    void loadScopeOptions();
    void loadSystemRules();
});

// 切换视角租户后，可见的系统规则集合可能变化
watch(myTenantId, () => {
    void loadSystemRules();
});

const columns = computed<TableColumnsType<Rule>>(() => [
    { title: 'ID', key: 'id', dataIndex: 'id', width: 80 },
    { title: '名称', key: 'name', dataIndex: 'name' },
    { title: '类型', key: 'type', dataIndex: 'type', width: 110 },
    { title: '优先级', key: 'priority', dataIndex: 'priority', width: 90 },
    { title: '匹配条件', key: 'scope', dataIndex: 'scope' },
    { title: '参数', key: 'config', dataIndex: 'config', width: 160 },
    { title: '状态', key: 'enabled', dataIndex: 'enabled', width: 90 },
    { title: '创建时间', key: 'created_at', dataIndex: 'created_at', width: 160 },
    { title: '操作', key: 'action', width: 100, fixed: 'right' as const },
]);

// 系统规则区没有编辑 / 删除，末尾改为提示列
const systemColumns = computed<TableColumnsType<Rule>>(() => [
    { title: 'ID', key: 'id', dataIndex: 'id', width: 80 },
    { title: '名称', key: 'name', dataIndex: 'name' },
    { title: '类型', key: 'type', dataIndex: 'type', width: 110 },
    { title: '优先级', key: 'priority', dataIndex: 'priority', width: 90 },
    { title: '匹配条件', key: 'scope', dataIndex: 'scope' },
    { title: '参数', key: 'config', dataIndex: 'config', width: 160 },
    { title: '状态', key: 'enabled', dataIndex: 'enabled', width: 90 },
    { title: '修改入口', key: 'edit_hint', width: 220 },
]);

function typeLabel(type: RuleType): string {
    if (type === 'rate_limit') {
        return '限流';
    }
    if (type === 'forbid_access') {
        return '禁止访问';
    }
    return '请求插件';
}

function typeTagColor(type: RuleType): string {
    if (type === 'rate_limit') {
        return 'blue';
    }
    if (type === 'forbid_access') {
        return 'purple';
    }
    return 'geekblue';
}

function configSummary(rule: Rule): string {
    if (rule.type === 'rate_limit') {
        const rpm = (rule.config as { rpm?: number | null }).rpm;
        if (rpm === null || rpm === undefined) {
            return '不限速';
        }
        if (rpm === 0) {
            return '不可用';
        }
        return `${rpm} RPM`;
    }
    if (rule.type === 'plugin') {
        const plugin = (rule.config as { plugin?: string }).plugin;
        return plugin ? `插件：${plugin}` : '—';
    }
    return '—';
}

function handleCreate(): void {
    dialogFormRef.value?.openCreate();
}

function handleEdit(record: Rule): void {
    dialogFormRef.value?.openEdit(record);
}

function handleSuccess(): void {
    void loadData();
    void loadSystemRules();
}

function handleDelete(record: Rule): void {
    Modal.confirm({
        title: '确认删除',
        content: `确定要删除规则 "${record.name}" 吗？删除后即时生效。`,
        okText: '确定',
        cancelText: '取消',
        okType: 'danger',
        onOk: async () => {
            try {
                await deleteRule(record.id);
                notifySuccess('删除成功');
                void loadData();
            } catch (error) {
                notifyRequestError(error, '删除失败');
            }
        },
    });
}
</script>

<style scoped>
.rule-list {
    background: var(--bg-page);
}

.table-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 16px;
}

.rule-action-button {
    color: var(--accent-primary);
}

.system-rule-section {
    margin-top: 24px;
}

.system-rule-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
}

.system-rule-title {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 15px;
    font-weight: 600;
}

.system-rule-alert {
    margin-bottom: 8px;
}

.field-help-icon {
    color: var(--text-secondary);
    font-size: 13px;
}

.config-hint {
    color: var(--text-secondary);
    font-size: 12px;
}
</style>
