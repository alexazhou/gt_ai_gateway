<template>
    <div class="login-container">
        <!-- 桌面端顶部拖动区：macOS 为原生红绿灯留位，Windows 为自绘标题栏留位 -->
        <div
            v-if="isDesktopApp"
            class="window-drag-strip"
            :class="{ 'window-drag-strip--windows': isWindowsApp }"
            data-tauri-drag-region="deep"
        ></div>
        <a-card class="login-card">
            <template #title>
                <div class="card-title">
                    <img src="/favicon.svg" alt="Logo" class="logo" />
                    <span>GT AI Gateway</span>
                </div>
            </template>
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
import { reactive, ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { notifyError, notifySuccess } from '@/utils/requestFeedback';
import { isTauri, isDesktopTauri, isWindowsTauri } from '@/utils/platform';

const isWindowsApp = isWindowsTauri();
const isDesktopApp = isDesktopTauri();

const router = useRouter();
const authStore = useAuthStore();

const loading = ref(false);

const formState = reactive({
    token: '',
});

const rules = {
    token: [{ required: true, message: '请输入 Token' }],
};

// 后端就绪后自动尝试登录
let unlistenBackend: (() => void) | null = null;

async function tryAutoLogin() {
    if (!authStore.isAuthenticated || loading.value) return;
    loading.value = true;
    try {
        const result = await authStore.validateToken();
        if (result.success) {
            const redirect = router.currentRoute.value.query.redirect as string;
            router.push(redirect || '/dashboard');
        }
    } catch {} finally {
        loading.value = false;
    }
}

onMounted(async () => {
    if (!isTauri()) return;
    // 先尝试一次
    await tryAutoLogin();
    // 后端就绪事件再次尝试
    if (isTauri()) {
        const { listen } = await import('@tauri-apps/api/event');
        const unlisten = await listen('backend-ready', () => tryAutoLogin());
        unlistenBackend = unlisten;
    }
});

onUnmounted(() => {
    if (unlistenBackend) unlistenBackend();
});

async function handleLogin() {
    if (!formState.token.trim()) {
        notifyError('请输入 Token');
        return;
    }

    loading.value = true;
    try {
        const result = await authStore.login(formState.token);
        if (result.success) {
            notifySuccess('登录成功');
            const redirect = router.currentRoute.value.query.redirect as string;
            router.push(redirect || '/dashboard');
        } else {
            notifyError(result.message === 'User disabled' ? '该账号已被禁用' : result.message || 'Token 验证失败');
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
    background-color: #f5f5f5;
    background-image: linear-gradient(#e5e5e5 1px, transparent 1px),
        linear-gradient(90deg, #e5e5e5 1px, transparent 1px);
    background-size: 20px 20px;
}

.window-drag-strip {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 24px;
}

/* 登录页没有品牌行，拖动区只需覆盖 32px 高的窗口按钮；
   主布局为 44px，与侧边栏品牌行对齐 */
.window-drag-strip--windows {
    height: 32px;
}

.login-card {
    width: 400px;
}

.card-title {
    display: flex;
    align-items: center;
    gap: 10px;
}

.logo {
    width: 24px;
    height: 24px;
    object-fit: contain;
}
</style>
