import { Context } from "hono";
import { SgRecord } from "../model/sgRecord";
import recordService from "../service/recordService";

async function listRecords(c: Context) {
    const records = await SgRecord.query().get();
    return c.json(records);
}

async function latestRecords(c: Context) {
    const { limit } = c.req.query();
    const limitNumber = limit ? parseInt(limit, 10) : 10;
    const records = await recordService.latest(limitNumber);
    return c.json(records);
}

async function getRecord(c: Context) {
    const { id } = c.req.param();
    console.log("id", id);

    const record = await SgRecord.query().find(id);

    if (!record) {
        return c.json({ error: "Record not found" }, 404);
    }

    return c.json(record);
}

export default {
    listRecords,
    latestRecords,
    getRecord,
};
