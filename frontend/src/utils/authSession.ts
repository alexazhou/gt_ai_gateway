const ADMIN_TOKEN_KEY = 'adminToken';

export function getAuthToken(): string {
    if (typeof window === 'undefined') {
        return '';
    }

    return window.localStorage.getItem(ADMIN_TOKEN_KEY) || '';
}

export function setAuthToken(token: string): void {
    if (typeof window === 'undefined') {
        return;
    }

    window.localStorage.setItem(ADMIN_TOKEN_KEY, token);
}

export function clearAuthToken(): void {
    if (typeof window === 'undefined') {
        return;
    }

    window.localStorage.removeItem(ADMIN_TOKEN_KEY);
}
