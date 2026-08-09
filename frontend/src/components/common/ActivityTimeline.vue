<template>
    <div class="activity-pane-content">
        <a-timeline v-if="activities.length > 0" class="activity-timeline">
            <a-timeline-item
                v-for="(item, index) in activities"
                :key="index"
                :color="getActivityLevelColor(item.level)"
            >
                <div class="activity-item">
                    <div class="activity-item-header">
                        <a-tag :color="getActivityStageColor(item)">{{ getActivityStageLabel(item.stage) }}</a-tag>
                        <span class="activity-message">{{ item.message }}</span>
                        <span class="activity-time">{{ formatActivityTime(item.ts) }}</span>
                    </div>
                    <div v-if="item.details && Object.keys(item.details).length > 0" class="activity-details">
                        <template v-for="(value, key) in item.details" :key="key">
                            <div v-if="key === 'response_body'" class="activity-response-block">
                                <div class="activity-detail-key">{{ getDetailLabel(key) }}</div>
                                <pre class="activity-response-body">{{ formatResponseBody(value) }}</pre>
                            </div>
                            <div v-else-if="key === 'vendor_name'" />
                            <div v-else-if="key === 'vendor_id'" class="activity-detail-row">
                                <span class="activity-detail-key">{{ getDetailLabel('vendor_name') }}</span>
                                <span class="activity-detail-value">{{ formatVendor(item) }}</span>
                            </div>
                            <div v-else-if="isDetailGroup(value)" class="activity-detail-group">
                                <div class="activity-detail-group-title">{{ getDetailLabel(key) }}</div>
                                <div class="activity-detail-group-content">
                                    <div v-for="(v, k) in value" :key="k" class="activity-detail-group-item">
                                        <span class="activity-detail-key-inline">{{ getInnerDetailLabel(key, k) }}</span>
                                        <span class="activity-detail-value">{{ formatInnerDetailValue(v) }}</span>
                                    </div>
                                </div>
                            </div>
                            <div v-else class="activity-detail-row">
                                <span class="activity-detail-key">{{ getDetailLabel(key) }}</span>
                                <span class="activity-detail-value">{{ formatDetailValue(key, value) }}</span>
                            </div>
                        </template>
                    </div>
                </div>
            </a-timeline-item>
        </a-timeline>
        <div v-else class="no-payload-hint">
            <div class="no-payload-title">暂无日志</div>
            <div class="no-payload-desc">该请求没有记录处理过程</div>
        </div>
    </div>
</template>

<script setup lang="ts">
import type { RecordActivityEntry } from '@/types/record';
import { FAILED_CODE_LABELS } from '@/constants/record';

defineProps<{ activities: RecordActivityEntry[] }>();

// ===== 请求活动日志（时间线） =====

const STAGE_LABELS: Record<string, string> = {
    routing: '路由',
    upstream_attempt: '上游请求',
    failover: '失败切换',
    plugin: '插件',
    conversion: '协议转换',
    result: '结果',
};

const STAGE_COLORS: Record<string, string> = {
    routing: 'blue',
    upstream_attempt: 'geekblue',
    failover: 'orange',
    plugin: 'purple',
    conversion: 'cyan',
    result: 'green',
};

const LEVEL_COLORS: Record<string, string> = {
    info: 'blue',
    warn: 'orange',
    error: 'red',
};

const DETAIL_LABELS: Record<string, string> = {
    vendor_id: '供应商 ID',
    vendor_name: '供应商',
    vendor_model_name: '供应商模型',
    upstream_format: '上游协议',
    client_format: '客户端协议',
    url: '上游地址',
    error: '错误',
    format: '格式',
    body_len_before: '转换前长度',
    body_len_after: '转换后长度',
    from: '从',
    to: '到',
    converter: '转换器',
    status: '状态',
    cost: '费用',
    failed_code: '失败原因',
    upstream_status: '上游状态码',
    response_body: '上游响应',
    client: '客户端',
    upstream: '上游',
    strategy: '路由策略',
};

// 路由策略值 → 中文标签
const STRATEGY_LABELS: Record<string, string> = {
    single: '单一路由',
    load_balance: '负载均衡',
    first_available: '首选可用',
};

// 嵌套详情分组内的字段标签
const GROUP_INNER_LABELS: Record<string, Record<string, string>> = {
    client: { model: '请求模型', format: '请求协议' },
    upstream: { vendor: '供应商', vendor_model: '上游模型', format: '上游协议' },
};

function isDetailGroup(value: unknown): boolean {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getInnerDetailLabel(group: string, key: string): string {
    return GROUP_INNER_LABELS[group]?.[key] ?? key;
}

function formatInnerDetailValue(value: unknown): string {
    if (value === null || value === undefined) return '-';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function getActivityStageLabel(stage: string): string {
    return STAGE_LABELS[stage] ?? stage;
}

function getActivityStageColor(item: RecordActivityEntry): string {
    if (item.stage === 'result') {
        return item.details?.status === 'failed' ? 'red' : 'green';
    }
    return STAGE_COLORS[item.stage] ?? 'default';
}

function getActivityLevelColor(level: string): string {
    return LEVEL_COLORS[level] ?? 'blue';
}

function getDetailLabel(key: string): string {
    return DETAIL_LABELS[key] ?? key;
}

function formatDetailValue(key: string, value: unknown): string {
    if (value === null || value === undefined) return '-';
    if (key === 'status') {
        return value === 'success' ? '成功' : value === 'failed' ? '失败' : String(value);
    }
    if (key === 'failed_code') {
        return FAILED_CODE_LABELS[value as string] ?? String(value);
    }
    if (key === 'strategy') {
        return STRATEGY_LABELS[value as string] ?? String(value);
    }
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function formatActivityTime(ts: number): string {
    if (!ts) return '-';
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function formatResponseBody(value: unknown): string {
    if (typeof value !== 'string') {
        return JSON.stringify(value, null, 2);
    }
    try {
        return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
        return value;
    }
}

function formatVendor(item: RecordActivityEntry): string {
    const name = item.details?.vendor_name;
    if (name) return String(name);
    return item.details?.vendor_id != null ? `供应商 ${item.details.vendor_id}` : '-';
}
</script>

<style scoped>
.activity-pane-content {
    margin-top: 8px;
}

.activity-timeline {
    padding: 8px 4px;
}

.activity-item-header {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}

.activity-message {
    font-size: 13px;
    color: var(--text-primary, #333);
}

.activity-time {
    margin-left: auto;
    font-size: 12px;
    color: var(--text-secondary, #999);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
}

.activity-details {
    margin-top: 6px;
    padding: 8px 10px;
    background: var(--bg-hover, #f5f5f5);
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.activity-detail-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 12px;
    word-break: break-all;
}

.activity-detail-key {
    color: var(--text-secondary, #999);
    flex-shrink: 0;
    min-width: 72px;
}

.activity-detail-value {
    color: var(--text-primary, #333);
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
}

.activity-detail-group {
    display: flex;
    align-items: baseline;
    gap: 16px;
    margin-top: 4px;
    padding-left: 8px;
    border-left: 2px solid var(--border-color, #f0f0f0);
}

.activity-detail-group-title {
    font-size: 12px;
    color: var(--text-secondary, #999);
    min-width: 48px;
    flex-shrink: 0;
}

.activity-detail-group-content {
    display: flex;
    align-items: baseline;
    gap: 24px;
    flex-wrap: wrap;
}

.activity-detail-group-item {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 12px;
}

.activity-detail-key-inline {
    color: var(--text-secondary, #999);
    flex-shrink: 0;
}

.activity-response-block {
    margin-top: 4px;
}

.activity-response-block .activity-detail-key {
    margin-bottom: 4px;
}

.activity-response-body {
    margin: 0;
    padding: 8px 10px;
    max-height: 240px;
    overflow: auto;
    background: var(--bg-page, #fff);
    border: 1px solid var(--border-color, #f0f0f0);
    border-radius: 6px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--text-primary, #333);
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
    white-space: pre-wrap;
    word-break: break-all;
}

.no-payload-hint {
    padding: 32px 0;
    text-align: center;
}

.no-payload-title {
    font-size: 16px;
    font-weight: 500;
    color: var(--text-primary, #333);
    margin-bottom: 8px;
}

.no-payload-desc {
    font-size: 13px;
    color: var(--text-secondary, #999);
}
</style>
