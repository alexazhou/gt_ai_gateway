import ormService from "./ormService";
import recordService from "./recordService";
import billingUtil from "../util/protocolUtil/billingUtil";
import { formatDbDatetime } from "../manager/recordManager";
import type { SqlStatement } from "../util/dbAdapterUtil";
import { SgRecordStatus } from "../constants";

/**
 * 请求结算：把「record 收尾」与「用户扣费」放在同一个原子批处理里提交。
 *
 * 背景（修复前）：`recordService.update(...)` 与 `userService.deductBalance(...)` 是两次独立写，
 * 中间任一步失败就会出现「记录成功但没扣费」或「扣了费但记录没结算」，且没有补偿。
 *
 * 现在的保证：
 * 1. 跨驱动原子性 —— D1 batch / better-sqlite3 transaction / MySQL 显式事务，全部成功或全部回滚；
 * 2. 幂等 —— 扣费语句带 `(SELECT status FROM record WHERE id = ?) <> 'success'` 守卫，
 *    同一 record 的结算被重复触发（waitUntil 重试、重复 finalize）只扣一次；
 * 3. 事务内不读配置 —— `module_billing_enabled` 由调用方在事务外取好后通过 `chargeUserId` 传入，
 *    避免事务期间产生额外 I/O（Worker 下 I/O 上下文敏感）。
 *
 * 响应体（response_data）存对象存储，不在表里，写入是幂等的，因此在事务前完成。
 */
export interface RecordSettlementInput {
    recordId: number;
    status: SgRecordStatus;
    /** 用量存储串（serializeStoredUsage 的结果）；undefined = 不改该列 */
    usage?: string | null;
    /** 费用，单位「元」；内部换算成整数微元写入 */
    cost: number;
    endAt: Date;
    firstTokenLatency?: number | null;
    /** 需要同时落库的失败码；undefined = 不改该列 */
    failedCode?: string | null;
    /** 响应体；undefined = 不落对象存储 */
    responseData?: string | null;
    /**
     * 需要扣费的用户 id。
     * null / undefined 表示本次不扣费（root 用户、计费开关关闭、失败请求）。
     */
    chargeUserId?: number | null;
}

export interface RecordSettlementResult {
    /** 实际写入的费用（元），便于调用方写活动日志 */
    cost: number;
}

function buildRecordUpdateSql(input: RecordSettlementInput, now: string): SqlStatement {
    const sets: string[] = [
        "status = ?",
        "cost = ?",
        "end_at = ?",
        "first_token_latency = ?",
        "updated_at = ?",
    ];
    const params: unknown[] = [
        input.status,
        billingUtil.toUnits(input.cost),
        formatDbDatetime(input.endAt),
        input.firstTokenLatency ?? null,
        now,
    ];

    if (input.usage !== undefined) {
        sets.push("usage = ?");
        params.push(input.usage);
    }
    if (input.failedCode !== undefined) {
        sets.push("failed_code = ?");
        params.push(input.failedCode);
    }

    params.push(input.recordId);
    return { sql: `UPDATE record SET ${sets.join(", ")} WHERE id = ?`, params };
}

function buildChargeSql(chargeUserId: number, costUnits: number, recordId: number, now: string): SqlStatement {
    // 顺序很重要：本语句必须排在同批 record UPDATE 之前 —— 守卫读的是「尚未结算」的状态，
    // 首次结算时扣费生效；重复结算时 record 已是 success，守卫为假，不会重复扣费。
    return {
        sql: `UPDATE user SET balance = balance - ?, updated_at = ? WHERE id = ? AND (SELECT COALESCE(status, '') FROM record WHERE id = ?) <> ?`,
        params: [costUnits, now, chargeUserId, recordId, SgRecordStatus.SUCCESS],
    };
}

async function settleRecord(input: RecordSettlementInput): Promise<RecordSettlementResult> {
    // 对象存储写在事务外（幂等，且不属于同库事务范围）
    if (input.responseData !== undefined) {
        await recordService.storeResponsePayload(input.recordId, input.responseData);
    }

    const now = formatDbDatetime(new Date());
    const costUnits = billingUtil.toUnits(input.cost);
    const statements: SqlStatement[] = [];

    const shouldCharge = input.chargeUserId != null && costUnits > 0;
    if (shouldCharge) {
        statements.push(buildChargeSql(input.chargeUserId as number, costUnits, input.recordId, now));
    }
    statements.push(buildRecordUpdateSql(input, now));

    await ormService.runAtomically(statements);
    return { cost: input.cost };
}

export default {
    settleRecord,
};
