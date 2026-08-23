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
    tenant_id?: number | null;
}

async function listRechargeRecords(query: RechargeRecordsQuery = {}, tenantId?: number) {
    const { user_id, type, limit = 100, offset = 0 } = query;

    const dbQuery = SgRechargeRecord.query();

    if (tenantId !== undefined) {
        dbQuery.where("tenant_id", tenantId);
    }

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

async function getRechargeRecord(id: number, tenantId?: number) {
    const q = SgRechargeRecord.query();
    if (tenantId !== undefined) {
        q.where("tenant_id", tenantId);
    }
    return await q.find(id);
}

async function create(data: RechargeRecordCreateData): Promise<SgRechargeRecord> {
    return await SgRechargeRecord.query().create({
        user_id: data.user_id,
        amount: data.amount,
        type: data.type,
        remark: data.remark ?? null,
        operator: data.operator ?? null,
        tenant_id: data.tenant_id ?? null,
    });
}

export default {
    listRechargeRecords,
    getRechargeRecord,
    create,
};
