import { isAxiosError } from 'axios';
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { status } from '@/api/system';
import { clearAuthToken, getAuthToken, setAuthToken } from '@/utils/authSession';

export const useAuthStore = defineStore('auth', () => {
    const token = ref<string>(getAuthToken());
    const userType = ref<string>('');
    // 当前登录用户 id：用于「不能修改自己」等判断（root 为 -1，多租户下 id 全局唯一）
    const userId = ref<number | null>(null);
    // 当前登录用户名：顶栏展示（root 为 "Root"）
    const userName = ref<string>('');
    // 系统管理员（root，或归属 main 租户的 admin）：与后端 TenantScope.isSystemAdmin 同源，
    // 由 /status.json 下发，前端不自行拼装判定条件（main 租户 id 在隔离开关闭时不下发）
    const isSystemAdmin = ref(false);
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
        userId.value = null;
        userName.value = '';
        isSystemAdmin.value = false;
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
            userId.value = data?.user_id ?? null;
            userName.value = data?.user_name ?? '';
            // 旧后端不返回该字段 → 退回「仅 root」，与改造前行为一致
            isSystemAdmin.value = data?.is_system_admin ?? (data?.user_type === 'root');
            return { success: true };
        } catch (error) {
            // 只有明确的 401/403 认证失败才清 Token
            // 网络错误时保留 Token（例如后端还没启动）
            const response = isAxiosError(error) ? error.response : undefined;
            const status = response?.status;
            const isAuthError = status === 401 || status === 403;
            if (isAuthError) {
                clearToken();
            }
            const responseError = (response?.data as { error?: string } | undefined)?.error;
            const message = isAuthError
                ? (responseError || 'Token 验证失败')
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
        userId,
        userName,
        isLoading,
        isAuthenticated,
        isRoot,
        isSystemAdmin,
        setToken,
        clearToken,
        validateToken,
        login,
        logout,
    };
});
