import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import * as tenantApi from '@/api/tenant';
import { getTenantViewId, setTenantViewId, clearTenantView } from '@/utils/tenantSession';
import { useAppStore } from './app';
import type { Tenant, CreateTenantRequest } from '@/types/tenant';

export const useTenantStore = defineStore('tenant', () => {
    const appStore = useAppStore();

    // 租户列表（root 拉取；admin 无权限时保持空）
    const tenants = ref<Tenant[]>([]);

    // 当前租户视角：'' = 未指定（默认 main / 用户自身租户）；非空 = 显式指定
    const currentTenantId = ref<string>(getTenantViewId());

    const currentTenantIdNum = computed<number | null>(() => {
        if (!currentTenantId.value) return null;
        const n = Number(currentTenantId.value);
        return Number.isFinite(n) ? n : null;
    });

    // 多租户功能开关（来自 /status.json）
    const multiTenantEnabled = computed<boolean>(() => appStore.multiTenantEnabled);

    // main 租户 id（来自 /status.json）
    const mainTenantId = computed<number | null>(() => appStore.mainTenantId);

    // 是否处于 main 视角（决定 config / client-config 等入口是否显示）
    const isMainView = computed<boolean>(() => {
        const mainId = appStore.mainTenantId;
        if (mainId === null) {
            // 功能开关关闭 / 未加载：一律视为 main 视角
            return true;
        }
        const view = currentTenantIdNum.value;
        if (view === null) {
            // 未显式指定：root 缺省 main；admin 用自身租户（tenant.id 来自 status）
            return appStore.tenantId === null || appStore.tenantId === mainId;
        }
        return view === mainId;
    });

    async function loadTenants() {
        try {
            const res = await tenantApi.listTenants({ pageSize: 100, offset: 0 });
            tenants.value = res.list;
        } catch (e) {
            // 非 root 无权限访问 /tenant.json，忽略（列表仅 root 使用）
        }
    }

    function setTenant(id: string | number | null) {
        if (id === null || id === '') {
            clearTenantView();
            currentTenantId.value = '';
        } else {
            setTenantViewId(id);
            currentTenantId.value = String(id);
        }
    }

    function reset() {
        setTenant(null);
        tenants.value = [];
    }

    async function createTenant(data: CreateTenantRequest): Promise<Tenant> {
        const tenant = await tenantApi.createTenant(data);
        await loadTenants();
        return tenant;
    }

    async function updateTenant(id: number, data: Partial<CreateTenantRequest>): Promise<Tenant> {
        const tenant = await tenantApi.updateTenant(id, data);
        await loadTenants();
        return tenant;
    }

    async function deleteTenant(id: number): Promise<{ success: boolean }> {
        const res = await tenantApi.deleteTenant(id);
        await loadTenants();
        return res;
    }

    return {
        tenants,
        mainTenantId,
        multiTenantEnabled,
        currentTenantId,
        currentTenantIdNum,
        isMainView,
        loadTenants,
        setTenant,
        reset,
        createTenant,
        updateTenant,
        deleteTenant,
    };
});
