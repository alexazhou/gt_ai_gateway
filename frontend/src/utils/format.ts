import dayjs from 'dayjs';

export function formatDate(date: Date | string | number, format: string = 'YYYY-MM-DD HH:mm:ss'): string {
    return dayjs(date).format(format);
}

export function maskToken(token: string, showLength: number = 4): string {
    if (!token) return '';
    if (token.length <= showLength * 2) return '****';
    return `${token.slice(0, showLength)}...${token.slice(-showLength)}`;
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
