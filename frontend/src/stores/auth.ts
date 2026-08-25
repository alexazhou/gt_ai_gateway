import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { status } from '@/api/system';
import { clearAuthToken, getAuthToken, setAuthToken } from '@/utils/authSession';

export const useAuthStore = defineStore('auth', () => {
    const token = ref<string>(getAuthToken());
    const userType = ref<string>('');
    const isLoading = ref(false);

    const isAuthenticated = computed(() => !!token.value);
    const isRoot = computed(() => userType.value === 'root');

    function setToken(newToken: string) {
        token.value = newToken;
        setAuthToken(newToken);
    }

    function clearToken() {
        token.value = '';
        userType.value = '';
        clearAuthToken();
    }

    async function validateToken(): Promise<{ success: boolean; message?: string }> {
        if (!token.value) return { success: false, message: '请输入 Token' };

        isLoading.value = true;
        try {
            const data = await status();
            if (data && data.user_type) {
                userType.value = data.user_type;
            } else {
                userType.value = 'admin';
            }
            return { success: true };
        } catch (error: any) {
            // 只有明确的 401/403 认证失败才清 Token
            // 网络错误时保留 Token（例如后端还没启动）
            const status = error?.response?.status;
            const isAuthError = status === 401 || status === 403;
            if (isAuthError) {
                clearToken();
            }
            const message = isAuthError
                ? (error?.response?.data?.error || 'Token 验证失败')
                : '连接后端失败，请稍后重试';
            return { success: false, message };
        } finally {
            isLoading.value = false;
        }
    }

    async function login(newToken: string): Promise<{ success: boolean; message?: string }> {
        setToken(newToken);
        return await validateToken();
    }

    function logout() {
        clearToken();
    }

    return {
        token,
        userType,
        isLoading,
        isAuthenticated,
        isRoot,
        setToken,
        clearToken,
        validateToken,
        login,
        logout,
    };
});
