import { SgUser } from "../model/sgUser";
import { ROOT_USER_ID, UserType } from "../constants";
import { SgRechargeRecord } from "../model/sgRechargeRecord";
import customError from "../util/customError";

function isRootToken(token: string, rootToken?: string): boolean {
    if (!rootToken) {
        return false;
    }
    return token === rootToken;
}

async function getUser(token: string): Promise<SgUser | null> {
    console.log("getUser", token);
    if (token == null) return null;

    return await SgUser.query().where("token", token).first();
}

async function getUserByToken(token: string, rootToken?: string): Promise<SgUser | null> {
    if (isRootToken(token, rootToken)) {
        const user = new SgUser();
        user.id = ROOT_USER_ID;
        user.name = "Root";
        user.token = token;
        user.type = UserType.ROOT;
        user.balance = Number.MAX_SAFE_INTEGER; // Root has unlimited balance
        return user;
    }

    return await getUser(token);
}

async function adjustBalance(
    userId: number,
    amount: number,
    type: string,
    remark: string | null = null,
    operator: string | null = null,
): Promise<SgUser> {
    const user = await SgUser.query().find(userId);
    if (!user) {
        throw new customError.NotFoundError("User not found");
    }

    const newBalance = user.balance + amount;
    if (newBalance < 0) {
        throw new customError.AppError("Insufficient balance", 400);
    }

    await user.update({ balance: newBalance });

    // Create recharge record
    await SgRechargeRecord.query().create({
        user_id: userId,
        amount: amount,
        type: type,
        remark: remark,
        operator: operator,
    });

    return user;
}

async function deductBalance(userId: number, amount: number): Promise<void> {
    const user = await SgUser.query().find(userId);
    if (!user) {
        throw new customError.NotFoundError("User not found");
    }

    // 允许余额为负（透支）：请求完成时正常扣减，余额不足的拦截在请求发起前由预检负责
    const newBalance = user.balance - amount;
    await user.update({ balance: newBalance });
}

async function checkBalance(userId: number, requiredAmount: number): Promise<boolean> {
    const user = await SgUser.query().find(userId);
    if (!user) {
        return false;
    }

    return user.balance >= requiredAmount;
}

export default {
    getUser,
    isRootToken,
    getUserByToken,
    adjustBalance,
    deductBalance,
    checkBalance,
};
