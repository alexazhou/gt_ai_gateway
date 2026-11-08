import request from '@/utils/request';
import type { Record, RecordQuery, RecordListResponse, RecordActivityResponse } from '@/types/record';

export function listRecords(query?: RecordQuery): Promise<RecordListResponse> {
    return request.get('/record/list.json', { params: query });
}

export function latestRecords(limit?: number): Promise<Record[]> {
    return request.get('/record/latest.json', { params: { limit } });
}

export function getRecord(id: number): Promise<Record> {
    return request.get(`/record/${id}`);
}

export function getRecordActivity(id: number): Promise<RecordActivityResponse> {
    return request.get(`/record/${id}/activity.json`);
}

export function deleteRecord(id: number): Promise<void> {
    return request.delete(`/record/${id}`);
}

export function clearPayload(): Promise<{ cleared: number }> {
    return request.delete('/record/clear-payload');
}

export function clearAllRecords(): Promise<{ deleted: number }> {
    return request.delete('/record/clear-all');
}

/**
 * 清理悬空数据（record 已不存在的 payload 与 activity）。root 专用，非 root 返回 403。
 */
export function clearOrphanRecords(): Promise<{ cleared_payloads: number; deleted_activities: number }> {
    return request.delete('/record/clear-orphans');
}
