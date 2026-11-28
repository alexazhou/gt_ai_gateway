import type { BaseEntity, PaginationParams } from './index';

export type RechargeRecordType = 'recharge' | 'adjustment';

export interface RechargeRecord extends BaseEntity {
    user_id: number;
    /** 整数微元（1 元 = 1_000_000 微元），负数表示扣减；展示时除以 BALANCE_SCALE */
    amount: number;
    type: RechargeRecordType;
    remark: string | null;
    operator: string | null;

    // 关联数据
    user_name?: string | null;
}

export interface AdjustBalanceRequest {
    amount: number;
    type: RechargeRecordType;
    remark?: string;
}

export interface RechargeRecordsQuery extends PaginationParams {
    user_id?: number;
    type?: RechargeRecordType;
}