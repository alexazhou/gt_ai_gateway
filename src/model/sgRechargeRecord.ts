import { Model } from "sutando";
import { inspect, InspectOptions } from "util";

class SgRechargeRecord extends Model {
    table = "recharge_records";

    id!: number;

    user_id!: number;
    /** 整数微元（1 元 = 1_000_000 微元），负数表示扣减 */
    amount!: number;
    type!: string; // 'recharge' or 'adjustment'
    remark!: string | null;
    operator!: string | null;
    /** 被充值用户的归属租户 */
    tenant_id!: number | null;

    created_at!: Date;
    updated_at!: Date;

    [inspect.custom](depth: number, options: InspectOptions) {
        return JSON.stringify(this.toData(), null, 2);
    }
}

export { SgRechargeRecord };