import { SgUser } from "../model/sgUser";
import { ROOT_USER_ID, UserType, BALANCE_SCALE } from "../constants";
import userManager from "../manager/userManager";
import rechargeRecordManager from "../manager/rechargeRecordManager";
import customError from "../util/customErrorUtil";

// 元 → 整数微元（DB 余额存整数微元，避免浮点）
function toUnits(yuan: number): number {
    return Math.round(yuan * BALANCE_SCALE);
}

// 恒定时间比较：先 SHA-256 到固定长度（32 字节），再逐字节 XOR-OR，
// 避免字符串 === 在首个差异字节处提前返回导致的时序侧信道。
function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) {
        return false;
    }
    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= a[i] ^ b[i];
    }
    return result === 0;
}

async function sha256(input: string): Promise<Uint8Array> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    return new Uint8Array(digest);
}

async function isRootToken(token: string, rootToken?: string): Promise<boolean> {
    if (!rootToken) {
        return false;
    }
    const [tokenHash, rootHash] = await Promise.all([sha256(token), sha256(rootToken)]);
    return constantTimeEqualBytes(tokenHash, rootHash);
}

async function getUserByToken(token: string, rootToken?: string): Promise<SgUser | null> {
    if (await isRootToken(token, rootToken)) {
        const user = new SgUser();
        user.id = ROOT_USER_ID;
        user.name = "Root";
        user.token = token;
        user.type = UserType.ROOT;
        user.balance = Number.MAX_SAFE_INTEGER; // Root has unlimited balance
        return user;
    }

    return await userManager.findByToken(token);
}

async function adjustBalance(
    userId: number,
    amount: number,
    type: string,
    remark: string | null = null,
    operator: string | null = null,
): Promise<SgUser> {
    const user = await userManager.findById(userId);
    if (!user) {
        throw new customError.NotFoundError("User not found");
    }

    // amount 为元，换算成整数微元后做整数加减，避免浮点
    const amountUnits = toUnits(amount);
    const newBalance = user.balance + amountUnits;
    if (newBalance < 0) {
        throw new customError.AppError("Insufficient balance", 400);
    }

    // 两步写操作（扣/加余额 + 写充值记录）分属 userManager.updateBalance 与
    // rechargeRecordManager.create，非原子（见 service_manager_split_design §6 方案 C）：
    // Worker 模式下 D1 不支持多语句事务（ormService 已绕过连接池），故维持原行为、
    // 不做事务包裹，仅把查询部分（findById）下沉到 manager。充值记录写入失败时
    // 余额已更新但不留记录，与拆分前行为一致。
    await userManager.updateBalance(userId, newBalance);

    // Create recharge record（amount 仍以"元"记录）
    await rechargeRecordManager.create({
        user_id: userId,
        amount: amount,
        type: type,
        remark: remark,
        operator: operator,
    });

    // 返回更新后的用户（updateBalance 走 query-builder，不回写内存实例，需重新读取）
    return (await userManager.findById(userId))!;
}

async function deductBalance(userId: number, amount: number): Promise<void> {
    const user = await userManager.findById(userId);
    if (!user) {
        throw new customError.NotFoundError("User not found");
    }

    // 允许余额为负（透支）：请求完成时正常扣减，余额不足的拦截在请求发起前由预检负责
    // 扣费 amount 为元，换算成整数微元做整数减法；余额本就是整数微元，无浮点漂移
    const amountUnits = toUnits(amount);
    await userManager.updateBalance(userId, user.balance - amountUnits);
}

async function checkBalance(userId: number, requiredAmount: number): Promise<boolean> {
    const user = await userManager.findById(userId);
    if (!user) {
        return false;
    }

    return user.balance >= toUnits(requiredAmount);
}

export default {
    isRootToken,
    getUserByToken,
    adjustBalance,
    deductBalance,
    checkBalance,
};
