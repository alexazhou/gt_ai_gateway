import { Model } from "sutando";
import { inspect, InspectOptions } from "util";
import { MicroAmountCast } from "../util/protocol/billingUtil";

class SgRechargeRecord extends Model {
    table = "recharge_records";

    casts = {
        // MySQL 下以整数微元存储（应用层仍以"元"读写），避免 DECIMAL 返回字符串
        amount: MicroAmountCast,
    };

    id!: number;

    user_id!: number;
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