<template>
    <div class="login-container">
        <a-card class="login-card" title="Serverless AI Gateway">
            <a-form
                :model="formState"
                :rules="rules"
                @finish="handleLogin"
                layout="vertical"
            >
                <a-form-item label="Admin Token" name="token">
                    <a-input
                        v-model:value="formState.token"
                        placeholder="请输入管理员 Token"
                        size="large"
                    />
                </a-form-item>
                <a-form-item>
                    <a-button
                        type="primary"
                        html-type="submit"
                        size="large"
                        block
                        :loading="loading"
                    >
                        登录
                    </a-button>
                </a-form-item>
            </a-form>
        </a-card>
    </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { notifyError, notifySuccess } from '@/utils/requestFeedback';

const router = useRouter();
const authStore = useAuthStore();

const loading = ref(false);

const formState = reactive({
    token: '',
});

const rules = {
    token: [{ required: true, message: '请输入 Token' }],
};

async function handleLogin() {
    if (!formState.token.trim()) {
        notifyError('请输入 Token');
        return;
    }

    loading.value = true;
    try {
        const success = await authStore.login(formState.token);
        if (success) {
            notifySuccess('登录成功');
            const redirect = router.currentRoute.value.query.redirect as string;
            router.push(redirect || '/dashboard');
        } else {
            notifyError('Token 验证失败');
        }
    } catch (_error) {
        notifyError('登录失败，请检查 Token');
    } finally {
        loading.value = false;
    }
}
</script>

<style scoped>
.login-container {
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
}

.login-card {
    width: 400px;
}
</style>
