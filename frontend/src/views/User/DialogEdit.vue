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
            <a-form-item label="Token">
                <div class="token-section">
                    <TokenDisplay :token="formState.token" />
                    <a-button
                        type="link"
                        @click="showRegenerateConfirm"
                    >
                        重新生成 Token
                    </a-button>
                </div>
            </a-form-item>
        </a-form>
    </a-modal>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue';
import { Modal } from 'ant-design-vue/es';
import type { FormInstance } from 'ant-design-vue/es';
import { updateUser } from '@/api/user';
import TokenDisplay from '@/components/common/TokenDisplay.vue';
import type { User } from '@/types/user';
import { notifyError, notifyRequestError, notifySuccess } from '@/utils/requestFeedback';

const emit = defineEmits<{
    success: [user: User];
}>();

const visible = ref(false);
const loading = ref(false);
const formRef = ref<FormInstance>();
const userId = ref<number>();

const formState = reactive({
    name: '',
    token: '',
});

const rules = {
    name: [{ required: true, message: '请输入用户名' }],
};

function open(user: User) {
    userId.value = user.id;
    formState.name = user.name;
    formState.token = user.token;
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
    userId.value = undefined;
}

defineExpose({ open });
</script>

<style scoped>
.token-section {
    display: flex;
    align-items: center;
    gap: 16px;
}
</style>
