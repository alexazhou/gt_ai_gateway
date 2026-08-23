import { defineStore } from 'pinia';
import { ref } from 'vue';
import { status } from '@/api/system';
import type { RunMode } from '@/types/system';
import packageJson from '../../package.json';

const FALLBACK_VERSION = packageJson.version;

export const useAppStore = defineStore('app', () => {
    const sidebarCollapsed = ref(false);
    const version = ref(FALLBACK_VERSION);
    const mode = ref<RunMode | ''>('');
    const isDeveloperMode = ref(localStorage.getItem('developerMode') === 'true');
    const r2StorageAvailable = ref(false);
    const r2StorageUnavailableReason = ref('');

    // 功能模块开关
    const moduleBillingEnabled = ref(false);
    const moduleApiPlaygroundEnabled = ref(false);
    const moduleClientConfigEnabled = ref(false);
    // 多租户隔离
    const multiTenantEnabled = ref(false);
    const tenantId = ref<number | null>(null);
    const mainTenantId = ref<number | null>(null);

    function toggleSidebar() {
        sidebarCollapsed.value = !sidebarCollapsed.value;
    }

    function enableDeveloperMode() {
        isDeveloperMode.value = true;
        localStorage.setItem('developerMode', 'true');
    }

    function disableDeveloperMode() {
        isDeveloperMode.value = false;
        localStorage.removeItem('developerMode');
    }

    async function fetchStatus() {
        try {
            const data = await status();
            version.value = data.system?.version || FALLBACK_VERSION;
            mode.value = data.mode || '';
            moduleBillingEnabled.value = data.modules?.billing ?? false;
            moduleApiPlaygroundEnabled.value = data.modules?.api_playground ?? false;
            moduleClientConfigEnabled.value = data.modules?.client_config ?? false;
            multiTenantEnabled.value = data.tenant?.multi_tenant_enabled ?? false;
            tenantId.value = data.tenant?.id ?? null;
            mainTenantId.value = data.tenant?.main_id ?? null;
            r2StorageAvailable.value = data.storage?.r2_available ?? false;
            r2StorageUnavailableReason.value = data.storage?.r2_unavailable_reason || '';
        } catch (error) {
            console.error('Failed to fetch version:', error);
        }
    }

    return {
        sidebarCollapsed,
        version,
        mode,
        isDeveloperMode,
        r2StorageAvailable,
        r2StorageUnavailableReason,
        moduleBillingEnabled,
        moduleApiPlaygroundEnabled,
        moduleClientConfigEnabled,
        multiTenantEnabled,
        tenantId,
        mainTenantId,
        toggleSidebar,
        enableDeveloperMode,
        disableDeveloperMode,
        fetchStatus,
    };
});
