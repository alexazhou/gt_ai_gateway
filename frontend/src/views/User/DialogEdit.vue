<template>
    <a-modal
        v-model:open="visible"
        title="编辑用户"
        @ok="handleOk"
        @cancel="handleCancel"
        :confirm-loading="loading"
    >
        <a-form
            :model="formState"
            :rules="rules"
            layout="vertical"
            ref="formRef"
        >
            <a-form-item label="用户名" name="name">
                <a-input v-model:value="formState.name" placeholder="请输入用户名" />
            </a-form-item>
            <a-form-item label="状态" name="status">
                <a-switch
                    v-model:checked="formState.status"
                    checked-children="启用"
                    un-checked-children="禁用"
                    checked-value="active"
                    un-checked-value="disabled"
                />
            </a-form-item>
            <a-form-item
                label="类型"
                name="type"
                :tooltip="typeTooltip"
            >
                <a-select
                    v-model:value="formState.type"
                    :disabled="isTypeLocked"
                    placeholder="请选择用户类型"
                >
                    <a-select-option value="normal">普通用户</a-select-option>
                    <a-select-option value="admin">管理员</a-select-option>
                </a-select>
            </a-form-item>
            <a-form-item label="Token" name="token" tooltip="留空保存时服务端会重新生成 Token；修改后旧 Token 将失效">
                <a-input-password
                    v-model:value="formState.token"
                    placeholder="请输入 Token"
                >
                    <template #addonAfter>
                        <a-button type="link" size="small" @click="showRegenerateConfirm">重新生成 Token</a-button>
                    </template>
                </a-input-password>
            </a-form-item>
        </a-form>
    </a-modal>
</template>

<script setup lang="ts">
import { ref, reactive, computed } from 'vue';
import { Modal } from 'ant-design-vue/es';
import type { FormInstance } from 'ant-design-vue/es';
import { updateUser } from '@/api/user';
import { useAuthStore } from '@/stores/auth';
import type { AssignableUserType, User, UserType } from '@/types/user';
import { notifyError, notifyRequestError, notifySuccess } from '@/utils/requestFeedback';

const emit = defineEmits<{
    success: [user: User];
}>();

const authStore = useAuthStore();

const visible = ref(false);
const loading = ref(false);
const formRef = ref<FormInstance>();
const userId = ref<number>();

const formState = reactive({
    name: '',
    token: '',
    status: 'active' as 'active' | 'disabled',
    type: 'normal' as AssignableUserType,
});

// 被编辑用户的原类型（root 为系统保留类型，下拉框里没有对应选项，需单独记一份）
const originalType = ref<UserType>('normal');

// 当前登录用户不能改自己的类型（后端同样拦截）：避免唯一管理员自我降级后无法进入后台
const isSelf = computed(() => userId.value !== undefined && userId.value === authStore.userId);
const isSystemRoot = computed(() => originalType.value === 'root');
const isTypeLocked = computed(() => isSelf.value || isSystemRoot.value);

const typeTooltip = computed(() => {
    if (isSelf.value) {
        return '不能修改自己的类型：若当前账号是唯一管理员，降级后将无人能再进入管理后台';
    }
    if (isSystemRoot.value) {
        return 'root 为系统保留类型（由 ROOT_TOKEN 提供），不可修改';
    }
    return '管理员才能登录后台，不会余额不足；普通用户只能通过 API 调用 LLM';
});

const rules = {
    name: [{ required: true, message: '请输入用户名' }],
};

function open(user: User) {
    userId.value = user.id;
    formState.name = user.name;
    formState.token = user.token;
    formState.status = user.status || 'active';
    formState.type = user.type === 'admin' ? 'admin' : 'normal';
    originalType.value = user.type;
    visible.value = true;
}

function showRegenerateConfirm() {
    Modal.confirm({
        title: '确认重新生成 Token',
        content: '重新生成 Token 后，旧的 Token 将立即失效，用户需要使用新的 Token 进行认证。确定要继续吗？',
        okText: '确定',
        cancelText: '取消',
        onOk: async () => {
            formState.token = crypto.randomUUID();
            notifySuccess('新 Token 已生成，请点击确定保存');
        },
    });
}

async function handleOk() {
    try {
        await formRef.value?.validate();
        if (!userId.value) {
            notifyError('用户 ID 无效');
            return;
        }

        loading.value = true;
        const user = await updateUser(userId.value, {
            name: formState.name,
            token: formState.token,
            status: formState.status,
            // 类型不可编辑时不提交该字段，避免触发后端 400/403（用户仍可正常改名、改状态）
            ...(isTypeLocked.value ? {} : { type: formState.type }),
        });
        notifySuccess('更新成功');
        emit('success', user);
        handleCancel();
    } catch (error) {
        notifyRequestError(error, '更新失败');
    } finally {
        loading.value = false;
    }
}

function handleCancel() {
    visible.value = false;
    formState.name = '';
    formState.token = '';
    formState.status = 'active';
    formState.type = 'normal';
    originalType.value = 'normal';
    userId.value = undefined;
}

defineExpose({ open });
</script>
