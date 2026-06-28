import { ClientName, ClientConnectionMode } from '@/types/clientConfig';
import { ApiFormat } from '@/types/gateway';
import type { CurrentClientConfig } from '@/types/clientConfig';
import type { UserType } from '@/types/user';
import type { Vendor, VendorType } from '@/types/vendor';


export const clientProtocolLabels: Record<ClientName, string> = {
    [ClientName.CLAUDE_CODE]: 'Anthropic',
    [ClientName.CODEX]: 'OpenAI Responses',
};


export function filterSelectOption(input: string, option: any): boolean {
    return String(option?.label ?? option?.children ?? '').toLowerCase().includes(input.toLowerCase());
}


export function getUserTypeLabel(type?: UserType): string {
    if (type === 'admin') return '管理员';
    if (type === 'root') return 'Root';
    return '普通用户';
}

export function getUserTypeColor(type?: UserType): string {
    if (type === 'admin') return 'blue';
    if (type === 'root') return 'purple';
    return 'default';
}


export function getConnectionModeLabel(mode?: ClientConnectionMode): string {
    if (mode === ClientConnectionMode.GATEWAY) return '代理模式';
    if (mode === ClientConnectionMode.VENDOR) return '供应商模式';
    if (mode === ClientConnectionMode.OFFICIAL) return '官方模式';
    return '未配置';
}

export function getConnectionModeColor(mode?: ClientConnectionMode): string {
    if (mode === ClientConnectionMode.GATEWAY) return 'blue';
    if (mode === ClientConnectionMode.VENDOR) return 'green';
    if (mode === ClientConnectionMode.OFFICIAL) return 'purple';
    return 'default';
}

export function isGatewayConfig(config?: CurrentClientConfig | null): boolean {
    return config?.connectionMode === ClientConnectionMode.GATEWAY;
}


export function getVendorTypeLabel(type?: VendorType): string {
    if (!type) return '';
    const labels: Record<VendorType, string> = {
        aliyun: 'Aliyun (通义千问)',
        aliyun_coding: 'Aliyun Coding',
        volcengine_coding: 'Volcengine Coding',
        deepseek: 'DeepSeek',
        mimo: 'Mimo',
        mimo_token_plan: 'Mimo Token Plan',
        opencode_go: 'OpenCode Go',
        openai: 'OpenAI',
        anthropic: 'Anthropic',
        google: 'Google',
        other: 'Other',
    };
    return labels[type] || type;
}

export function getVendorTypeColor(type?: VendorType): string {
    if (!type) return 'default';
    const colors: Record<VendorType, string> = {
        aliyun: 'orange',
        aliyun_coding: 'orange',
        volcengine_coding: 'purple',
        deepseek: '',
        mimo: 'blue',
        mimo_token_plan: 'blue',
        opencode_go: 'cyan',
        openai: 'green',
        anthropic: 'orange',
        google: '',
        other: 'default',
    };
    return colors[type] || 'default';
}

export function getVendorTypeTagStyle(type?: VendorType) {
    if (type === 'deepseek' || type === 'google') {
        return {
            color: 'var(--accent-primary)',
            backgroundColor: 'var(--accent-primary-soft)',
            borderColor: 'var(--accent-primary-border)',
        };
    }
    return undefined;
}


export function getVendorUrl(vendor: Vendor, protocol: ApiFormat, presetUrls: Record<string, Record<string, string>>): string {
    const presets = presetUrls[vendor.type] || {};
    const urls = { ...presets, ...vendor.urls };

    if (protocol === ApiFormat.RESPONSES) {
        return urls.responses || urls.openai || '';
    }

    return urls.anthropic || '';
}
