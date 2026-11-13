import request from '@/utils/request';
import type {
    Record,
    RecordQuery,
    RecordListResponse,
    RecordActivityResponse,
    OrphanCleanupStats,
    OrphanCleanupStepInput,
    OrphanCleanupStepResult,
} from '@/types/record';

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
 *
 * 分两段：先取分母快照，再由前端循环调 step 逐片推进。
 * 服务端不保存任何状态，游标由调用方持有并回传。
 */

/** 取进度分母快照：需要在开始清理前调用一次，之后不再重新统计（分母缩水会让进度条往回跳） */
export function getOrphanCleanupStats(): Promise<OrphanCleanupStats> {
    return request.get('/record/clear-orphans/stats.json');
}

/** 推进一片：检查并删除当前游标之后的一页，返回新游标与本片增量 */
export function stepOrphanCleanup(input: OrphanCleanupStepInput): Promise<OrphanCleanupStepResult> {
    return request.post('/record/clear-orphans/step', input);
}
