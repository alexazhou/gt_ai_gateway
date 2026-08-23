<template>
    <div class="tenant-page">
        <div class="page-header">
            <div class="page-title">租户管理</div>
            <a-button type="primary" @click="openCreate">新建租户</a-button>
        </div>

        <a-alert
            v-if="!tenantStore.multiTenantEnabled"
            type="warning"
            show-icon
            message="多租户隔离未开启"
            description="当前为逻辑单租户模式。请在「设置」中开启「多租户隔离」后再管理租户。"
            style="margin-bottom: 16px;"
        />

        <a-table
            :columns="columns"
            :data-source="tenantStore.tenants"
            :loading="loading"
            :pagination="false"
            :row-key="(record: Tenant) => record.id"
        >
            <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'name'">
                    <a-space>
                        <span>{{ record.name }}</span>
                        <a-tag v-if="record.name === 'main'" color="blue">主租户</a-tag>
                    </a-space>
                </template>
                <template v-else-if="column.key === 'action'">
                    <a-space>
                        <a-button size="small" @click="openEdit(record)">编辑</a-button>
                        <a-popconfirm
                            title="确认删除该租户？仅空租户（无用户/模型/供应商）可删。"
                            :disabled="record.name === 'main'"
                            @confirm="handleDelete(record)"
                        >
                            <a-button size="small" danger :disabled="record.name === 'main'">删除</a-button>
                        </a-popconfirm>
                    </a-space>
                </template>
            </template>
        </a-table>

        <a-modal
            v-model:open="modalOpen"
            :title="editing ? '编辑租户' : '新建租户'"
            @ok="handleSubmit"
            :confirm-loading="submitting"
            :destroy-on-close="true"
        >
            <a-form :label-col="{ span: 5 }" :wrapper-col="{ span: 17 }">
                <a-form-item label="租户名" required>
                    <a-input v-model:value="form.name" placeholder="唯一租户标识" :disabled="editing" />
                </a-form-item>
                <a-form-item label="描述">
                    <a-textarea v-model:value="form.description" :rows="3" placeholder="选填" />
                </a-form-item>
            </a-form>
        </a-modal>
    </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { message } from 'ant-design-vue/es';
import { useTenantStore } from '@/stores/tenant';
import type { Tenant } from '@/types/tenant';

const tenantStore = useTenantStore();
const loading = ref(false);
const modalOpen = ref(false);
const submitting = ref(false);
const editing = ref(false);
const form = reactive<{ name: string; description?: string }>({ name: '', description: '' });

const columns = [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 80 },
    { title: '租户名', dataIndex: 'name', key: 'name' },
    { title: '描述', dataIndex: 'description', key: 'description', ellipsis: true },
    { title: '创建时间', dataIndex: 'created_at', key: 'created_at', width: 180 },
    { title: '操作', key: 'action', width: 160 },
];

async function load() {
    loading.value = true;
    try {
        await tenantStore.loadTenants();
    } finally {
        loading.value = false;
    }
}

function openCreate() {
    editing.value = false;
    form.name = '';
    form.description = '';
    modalOpen.value = true;
}

function openEdit(record: Tenant) {
    editing.value = true;
    form.name = record.name;
    form.description = record.description ?? '';
    modalOpen.value = true;
}

async function handleSubmit() {
    if (!form.name.trim()) {
        message.warning('请输入租户名');
        return;
    }
    submitting.value = true;
    try {
        if (editing.value) {
            const target = tenantStore.tenants.find(t => t.name === form.name);
            if (!target) {
                message.error('租户不存在');
                return;
            }
            await tenantStore.updateTenant(target.id, { name: form.name, description: form.description });
            message.success('租户已更新');
        } else {
            await tenantStore.createTenant({ name: form.name, description: form.description });
            message.success('租户已创建');
        }
        modalOpen.value = false;
    } catch (e: any) {
        message.error(e?.message || '操作失败');
    } finally {
        submitting.value = false;
    }
}

async function handleDelete(record: Tenant) {
    try {
        await tenantStore.deleteTenant(record.id);
        message.success('租户已删除');
    } catch (e: any) {
        message.error(e?.message || '删除失败');
    }
}

onMounted(load);
</script>

<style scoped>
.tenant-page {
    padding: 16px;
}

.page-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
}

.page-title {
    font-size: 18px;
    font-weight: 600;
    color: var(--text-primary);
}
</style>
