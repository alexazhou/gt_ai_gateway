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
                        {{ record.type === 'rate_limit' ? '限流' : '访问控制' }}
                    </a-tag>
                </template>
                <template v-if="column.key === 'scope'">
                    <span class="scope-preview">{{ scopeSummary(record.scope) }}</span>
                </template>
                <template v-if="column.key === 'config'">
                    <span>{{ configSummary(record) }}</span>
                </template>
                <template v-if="column.key === 'enabled'">
                    <a-tag :color="Boolean(record.enabled) ? 'green' : 'red'">
                        {{ Boolean(record.enabled) ? '启用' : '停用' }}
                    </a-tag>
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
import { computed, ref } from 'vue';
import type { TableColumnsType } from 'ant-design-vue';
import { Modal } from 'ant-design-vue/es';
import { DeleteOutlined, EditOutlined } from '@ant-design/icons-vue';
import { deleteRule, listRules } from '@/api/rule';
import { useResourceTable } from '@/composables/useResourceTable';
import { formatDate } from '@/utils/format';
import DialogForm from './DialogForm.vue';
import type { ExprNode, Rule, RuleQuery } from '@/types/rule';
import { notifyRequestError, notifySuccess } from '@/utils/requestFeedback';

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

const DIMENSION_LABELS: Record<string, string> = {
    user_id: '用户',
    model_id: '模型',
    vendor_id: '供应商',
};

const OPERATOR_LABELS: Record<string, string> = {
    '=': '=',
    '!=': '≠',
    in: '∈',
    'not in': '∉',
};

function scopeSummary(node: ExprNode): string {
    if (node.type === 'const') {
        return '全部匹配';
    }
    if (node.type === 'and' || node.type === 'or') {
        const op = node.type === 'and' ? '且' : '或';
        return `(${node.values.map(child => scopeSummary(child)).join(` ${op} `)})`;
    }
    const leaf = node as Extract<ExprNode, { oper: string }>;
    const values = leaf.values.join(',');
    return `${DIMENSION_LABELS[leaf.type] ?? leaf.type} ${OPERATOR_LABELS[leaf.oper] ?? leaf.oper} ${values}`;
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

.scope-preview {
    font-family: var(--font-mono, monospace);
    font-size: 12px;
    color: var(--text-secondary);
    word-break: break-all;
}
</style>
