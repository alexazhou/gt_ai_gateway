import { MIN_DEDUCTION_UNIT } from "../constants";


// 金额取整到最小扣减单位（0.000001 元）的整数倍；
// 正值低于最小单位时按最小单位收取，避免出现极小数的浮点噪声/科学计数法
function quantizeAmount(amount: number): number {
    if (amount <= 0) {
        return 0;
    }
    const units = Math.round(amount / MIN_DEDUCTION_UNIT);
    return Math.max(units, 1) * MIN_DEDUCTION_UNIT;
}


export default {
    quantizeAmount,
};
