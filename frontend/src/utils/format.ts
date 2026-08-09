import dayjs from 'dayjs';

// 后端 balance 字段以整数微元返回（1 元 = 1000000 微元），前端展示时换算为"元"
export const BALANCE_SCALE = 1_000_000;

export function formatDate(date: Date | string | number, format: string = 'YYYY-MM-DD HH:mm:ss'): string {
    return dayjs(date).format(format);
}

export function maskToken(token: string, showLength: number = 4): string {
    if (!token) return '';
    if (token.length <= showLength * 2) return '******';
    return `${token.slice(0, showLength)}******${token.slice(-showLength)}`;
}

export function truncateText(text: string, maxLength: number = 50): string {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}...`;
}

export function capitalizeFirst(str: string): string {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
}

export function formatBalance(value: number | null | undefined): string {
    const num = Number(value ?? 0);
    if (!Number.isFinite(num)) return '0.00';
    // 微小正值视为 0；负值（欠费）如实显示（用 6 位小数覆盖微元粒度），
    // 避免页面显示 0.00 却被后端按负余额拦截
    if (num >= 0 && num < 0.005) return '0.00';
    if (num < 0 && num > -0.005) return num.toFixed(6);
    return num.toFixed(2);
}
