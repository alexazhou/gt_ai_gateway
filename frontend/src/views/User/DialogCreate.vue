<template>
    <a-modal
        v-model:open="visible"
        title="新建用户"
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
            <a-form-item label="Token（可选）" name="token" tooltip="留空则由服务端自动生成；填写后将使用该 Token">
                <a-input-password
                    v-model:value="formState.token"
                    placeholder="请输入 Token"
                >
                    <template #addonAfter>
                        <a-button type="link" size="small" @click="generateToken">生成 UUID</a-button>
                    </template>
                </a-input-password>
            </a-form-item>
            <a-form-item label="类型" name="type" tooltip="管理员才能登录后台，不会余额不足；普通用户只能通过 API 调用 LLM">
                <a-select v-model:value="formState.type" placeholder="请选择用户类型">
                    <a-select-option value="normal">普通用户</a-select-option>
                    <a-select-option value="admin">管理员</a-select-option>
                </a-select>
            </a-form-item>
        </a-form>
    </a-modal>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue';
import type { FormInstance } from 'ant-design-vue/es';
import { createUser } from '@/api/user';
import type { AssignableUserType, User } from '@/types/user';
import { notifyRequestError, notifySuccess } from '@/utils/requestFeedback';

const emit = defineEmits<{
    success: [user: User];
}>();

const visible = ref(false);
const loading = ref(false);
const formRef = ref<FormInstance>();

const formState = reactive({
    name: '',
    token: '',
    type: 'normal' as AssignableUserType,
});

const rules = {
    name: [{ required: true, message: '请输入用户名' }],
    type: [{ required: true, message: '请选择用户类型' }],
};

function open() {
    visible.value = true;
}

function generateToken() {
    formState.token = crypto.randomUUID();
}

async function handleOk() {
    try {
        await formRef.value?.validate();
        loading.value = true;
        const user = await createUser(formState);
        notifySuccess('创建成功');
        emit('success', user);
        handleCancel();
    } catch (error) {
        notifyRequestError(error, '创建失败');
    } finally {
        loading.value = false;
    }
}

function handleCancel() {
    visible.value = false;
    formState.name = '';
    formState.token = '';
    formState.type = 'normal';
}

defineExpose({ open });
</script>
