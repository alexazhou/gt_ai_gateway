import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { welcome } from '@/api/system';

export const useAuthStore = defineStore('auth', () => {
    const token = ref<string>(localStorage.getItem('adminToken') || '');
    const isLoading = ref(false);

    const isAuthenticated = computed(() => !!token.value);

    function setToken(newToken: string) {
        token.value = newToken;
        localStorage.setItem('adminToken', newToken);
    }

    function clearToken() {
        token.value = '';
        localStorage.removeItem('adminToken');
    }

    async function validateToken(): Promise<boolean> {
        if (!token.value) return false;

        isLoading.value = true;
        try {
            await welcome();
            return true;
        } catch {
            clearToken();
            return false;
        } finally {
            isLoading.value = false;
        }
    }

    async function login(newToken: string): Promise<boolean> {
        setToken(newToken);
        return await validateToken();
    }

    function logout() {
        clearToken();
    }

    return {
        token,
        isLoading,
        isAuthenticated,
        setToken,
        clearToken,
        validateToken,
        login,
        logout,
    };
});
