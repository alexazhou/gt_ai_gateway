import { CastsAttributes } from "sutando";
import { MIN_DEDUCTION_UNIT, BALANCE_SCALE } from "../../constants";


// 金额取整到最小扣减单位（0.000001 元）的整数倍；
// 正值低于最小单位时按最小单位收取，避免出现极小数的浮点噪声/科学计数法
function quantizeAmount(amount: number): number {
    if (amount <= 0) {
        return 0;
    }
    const units = Math.round(amount / MIN_DEDUCTION_UNIT);
    return Math.max(units, 1) * MIN_DEDUCTION_UNIT;
}


// 元 → 整数微元（1 元 = 1_000_000 微元）
function toUnits(yuan: number): number {
    return Math.round(yuan * BALANCE_SCALE);
}


// 整数微元 → 元
function toYuan(units: number): number {
    return Number(units) / BALANCE_SCALE;
}


// 金额列的存取 cast：
// SQLite 与 MySQL 统一以"整数微元"存储（1 元 = 1_000_000 微元），应用层一律以"元"读写，
// 该 cast 在存取边界换算成整数微元，避免 DECIMAL 列返回字符串 / 浮点精度问题。
export class MicroAmountCast extends CastsAttributes {
    static get(...args: any[]): any {
        const value = args[2];
        if (value === null || value === undefined) {
            return value;
        }
        return toYuan(value);
    }

    static set(...args: any[]): any {
        const value = args[2];
        if (value === null || value === undefined) {
            return value;
        }
        return toUnits(value);
    }
}


export default {
    quantizeAmount,
    toUnits,
    toYuan,
    MicroAmountCast,
};
