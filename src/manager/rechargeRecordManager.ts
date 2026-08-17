import { SgRechargeRecord } from "../model/sgRechargeRecord";

interface RechargeRecordsQuery {
    user_id?: number;
    type?: string;
    limit?: number;
    offset?: number;
}

interface RechargeRecordCreateData {
    user_id: number;
    amount: number;
    type: string;
    remark?: string | null;
    operator?: string | null;
}

async function listRechargeRecords(query: RechargeRecordsQuery = {}) {
    const { user_id, type, limit = 100, offset = 0 } = query;

    const dbQuery = SgRechargeRecord.query();

    if (user_id !== undefined) {
        dbQuery.where("user_id", user_id);
    }

    if (type !== undefined) {
        dbQuery.where("type", type);
    }

    const total = Number(await dbQuery.clone().count() || 0);
    const list = (await dbQuery.orderBy("id", "desc").limit(limit).offset(offset).get()).all();

    return {
        list,
        total,
    };
}

async function getRechargeRecord(id: number) {
    return await SgRechargeRecord.query().find(id);
}

async function create(data: RechargeRecordCreateData): Promise<SgRechargeRecord> {
    return await SgRechargeRecord.query().create({
        user_id: data.user_id,
        amount: data.amount,
        type: data.type,
        remark: data.remark ?? null,
        operator: data.operator ?? null,
    });
}

export default {
    listRechargeRecords,
    getRechargeRecord,
    create,
};
