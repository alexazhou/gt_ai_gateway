import { Context } from "hono";
import rechargeRecordService from "../service/rechargeRecordService";
import { parsePaginationQuery } from "../util/pagination";

async function listRechargeRecords(c: Context) {
    const query = c.req.query();
    const userId = query.user_id ? parseInt(query.user_id, 10) : undefined;
    const type = query.type;
    const { pageSize, offset } = parsePaginationQuery(query, 10);

    try {
        const records = await rechargeRecordService.listRechargeRecords({
            user_id: userId,
            type,
            limit: pageSize,
            offset,
        });
        return c.json(records);
    } catch (error: any) {
        console.error("[balanceController] Error listing recharge records:", error);
        return c.json(
            { error: "Failed to list recharge records", message: String(error) },
            500,
        );
    }
}

async function getRechargeRecord(c: Context) {
    const id = c.req.param("id");
    const recordId = parseInt(id, 10);

    if (isNaN(recordId)) {
        return c.json({ error: "Invalid ID format" }, 400);
    }

    try {
        const record = await rechargeRecordService.getRechargeRecord(recordId);
        if (!record) {
            return c.json({ error: "Recharge record not found" }, 404);
        }
        return c.json(record);
    } catch (error: any) {
        console.error("[balanceController] Error getting recharge record:", error);
        return c.json(
            { error: "Failed to get recharge record", message: String(error) },
            500,
        );
    }
}

export default {
    listRechargeRecords,
    getRechargeRecord,
};
