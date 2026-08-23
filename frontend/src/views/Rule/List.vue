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
                    <a-tag :color="record.type === 'rate_limit' ? 'blue' : 'purple'">
                        {{ record.type === 'rate_limit' ? '限流' : '禁止访问' }}
                    </a-tag>
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
    </div>

    <DialogForm ref="dialogFormRef" @success="handleSuccess" />
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { TableColumnsType } from 'ant-design-vue';
import { Modal } from 'ant-design-vue/es';
import { DeleteOutlined, EditOutlined } from '@ant-design/icons-vue';
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
import type { Rule, RuleQuery, ScopeOptions } from '@/types/rule';
import { notifyRequestError, notifySuccess } from '@/utils/requestFeedback';

const tenantStore = useTenantStore();
const appStore = useAppStore();

// 当前视角租户 id（root 取切换的视角；admin 取自身租户；root 未切换时缺省 main）
const myTenantId = computed(() => tenantStore.currentTenantIdNum ?? appStore.tenantId ?? appStore.mainTenantId);

// 共享规则识别：main 租户规则 cross_tenant=1，且不属于当前视角租户 → 只读
function isSharedRule(record: Rule): boolean {
    return Boolean(record.cross_tenant)
        && typeof record.tenant_id === 'number'
        && myTenantId.value !== null
        && record.tenant_id !== myTenantId.value;
}

const { loading, data, pagination, searchForm, loadData, handleSearch, handleReset, handleTableChange } = useResourceTable<Rule, RuleQuery>({
    initialSearchForm: {
        keyword: undefined,
    },
    fetcher: listRules,
    resetSearchForm: (form) => {
        form.keyword = undefined;
    },
});

const dialogFormRef = ref<InstanceType<typeof DialogForm>>();
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
        console.error('[RuleList] Failed to load scope options:', e);
    }
}

onMounted(() => {
    void loadScopeOptions();
});

const columns = computed<TableColumnsType<Rule>>(() => [
    { title: 'ID', key: 'id', dataIndex: 'id', width: 80 },
    { title: '名称', key: 'name', dataIndex: 'name' },
    { title: '类型', key: 'type', dataIndex: 'type', width: 110 },
    { title: '匹配条件', key: 'scope', dataIndex: 'scope' },
    { title: '参数', key: 'config', dataIndex: 'config', width: 160 },
    { title: '状态', key: 'enabled', dataIndex: 'enabled', width: 90 },
    { title: '创建时间', key: 'created_at', dataIndex: 'created_at', width: 160 },
    { title: '操作', key: 'action', width: 100, fixed: 'right' as const },
]);

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
    return '—';
}

function handleCreate(): void {
    dialogFormRef.value?.openCreate();
}

function handleEdit(record: Rule): void {
    dialogFormRef.value?.openEdit(record);
}

function handleSuccess(): void {
    loadData();
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
    padding: 24px;
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
</style>
