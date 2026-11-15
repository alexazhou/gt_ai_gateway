import { SgRequestActivity } from "../model/sgRequestActivity";
import { bindParamBatchSize } from "../util/db/bindParamUtil";

async function findByRecordId(recordId: number): Promise<SgRequestActivity | null> {
    return await SgRequestActivity.query().where("record_id", recordId).first();
}

/** 批量查活动行（P2-27：孤儿回收按页批量读，避免逐条往返） */
async function findByRecordIds(recordIds: number[]): Promise<SgRequestActivity[]> {
    if (recordIds.length === 0) {
        return [];
    }
    const rows = await SgRequestActivity.query().whereIn("record_id", recordIds).get();
    return rows.all();
}

async function updateActivities(recordId: number, activitiesJson: string): Promise<void> {
    await SgRequestActivity.query().where("record_id", recordId).update({
        activities: activitiesJson,
    });
}

async function createActivity(recordId: number, activitiesJson: string): Promise<void> {
    await SgRequestActivity.query().create({
        record_id: recordId,
        activities: activitiesJson,
    });
}

/**
 * 按 record_id 批量删除活动时间线。
 *
 * request_activity 与 record 只是逻辑关联（无外键级联），删除 record 时必须显式清理，
 * 否则整行 JSON 时间线会永久留在库里。返回实际删除行数（调用方用于回报）。
 *
 * **为什么先 count 再 delete**：worker 模式走的是 knex 的 D1 方言，它把
 * `run()` 的返回值只取 `results`（`knex-cloudflare-d1`：`obj.response = results`），
 * 而 D1 删改语句的影响行数在 `meta.changes` 里——被丢掉了，于是 `.delete()` 恒返回 0。
 * 直接拿它回报，界面就会一直显示「已清理 0 条」，而数据其实已经删掉了。
 * 这里改成删前统计待删行数：多一次 count，换来两种模式下口径一致。
 */
async function deleteByRecordIds(recordIds: number[]): Promise<number> {
    const batchSize = bindParamBatchSize();
    let deleted = 0;
    for (let i = 0; i < recordIds.length; i += batchSize) {
        const batch = recordIds.slice(i, i + batchSize);
        deleted += Number(await SgRequestActivity.query().whereIn("record_id", batch).count() || 0);
        await SgRequestActivity.query().whereIn("record_id", batch).delete();
    }
    return deleted;
}

/**
 * 按 record_id keyset 分页列出（只取该列，不加载 activities JSON）。
 *
 * 孤儿清理用：调用方逐页判定「这批 record_id 指向的 record 是否还存在」，不存在的当场删，
 * 因此这里必须分页而不是全量 —— 全量返回会把整列的 id 常驻内存，条数一多直接打爆 worker。
 *
 * @param afterRecordId 上一页最后一个 record_id；null/undefined 表示从第一页开始
 */
async function listRecordIdsPage(afterRecordId: number | null | undefined, limit: number): Promise<number[]> {
    const query = SgRequestActivity.query().select("record_id");
    if (afterRecordId !== null && afterRecordId !== undefined) {
        query.where("record_id", ">", afterRecordId);
    }
    const rows = await query.orderBy("record_id", "asc").limit(limit).get();
    return rows.all().map(r => Number(r.record_id));
}

/** 统计活动时间线总行数（孤儿清理进度条的分母） */
async function countAll(): Promise<number> {
    return Number(await SgRequestActivity.query().count() || 0);
}

export default {
    findByRecordId,
    findByRecordIds,
    updateActivities,
    createActivity,
    deleteByRecordIds,
    listRecordIdsPage,
    countAll,
};
