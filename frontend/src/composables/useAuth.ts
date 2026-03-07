import { useAuthStore } from '@/stores/auth';

export function useAuth() {
    const authStore = useAuthStore();

    return {
        token: authStore.token,
        isLoading: authStore.isLoading,
        isAuthenticated: authStore.isAuthenticated,
        login: authStore.login,
        logout: authStore.logout,
        validateToken: authStore.validateToken,
    };
}
