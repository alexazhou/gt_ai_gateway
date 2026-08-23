// 当前租户视角（root 可切换；admin 无视角，固定自身租户）。
// 与 authSession 同模式：内存优先 + localStorage 持久化。空串 = 未指定（后端按用户自身租户解析）。

const TENANT_VIEW_KEY = 'tenantViewId';

let memoryTenantId = '';

export function getTenantViewId(): string {
    if (memoryTenantId) {
        return memoryTenantId;
    }

    if (typeof window === 'undefined') {
        return '';
    }

    return window.localStorage.getItem(TENANT_VIEW_KEY) || '';
}

export function setTenantViewId(id: string | number, options: { persist?: boolean } = {}): void {
    memoryTenantId = String(id);

    if (typeof window === 'undefined') {
        return;
    }

    if (options.persist !== false) {
        window.localStorage.setItem(TENANT_VIEW_KEY, String(id));
    }
}

export function clearTenantView(): void {
    memoryTenantId = '';

    if (typeof window === 'undefined') {
        return;
    }

    window.localStorage.removeItem(TENANT_VIEW_KEY);
}
