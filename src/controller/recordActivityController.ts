import { Context } from "hono";
import { SgRecord } from "../model/sgRecord";
import requestActivityService from "../service/requestActivityService";


async function getRecordActivity(c: Context) {
    const recordId = parseInt(c.req.param("id"), 10);
    if (isNaN(recordId)) {
        return c.json({ error: "Invalid ID format" }, 400);
    }

    const record = await SgRecord.query().find(recordId);
    if (!record) {
        return c.json({ error: "Record not found" }, 404);
    }

    const activities = await requestActivityService.getByRecordId(recordId);
    return c.json({ record_id: recordId, activities });
}

export default {
    getRecordActivity,
};
