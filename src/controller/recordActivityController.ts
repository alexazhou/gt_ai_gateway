import { Context } from "hono";
import recordManager from "../manager/recordManager";
import requestActivityService from "../service/requestActivityService";


async function getRecordActivity(c: Context) {
    const scope = c.get("tenantScope")!;
    const recordId = parseInt(c.req.param("id"), 10);
    if (isNaN(recordId)) {
        return c.json({ error: "Invalid ID format" }, 400);
    }

    const record = await recordManager.findByIdInTenant(recordId, scope.tenantId);
    if (!record) {
        return c.json({ error: "Record not found" }, 404);
    }

    const activities = await requestActivityService.getByRecordId(recordId);
    return c.json({ record_id: recordId, activities });
}

export default {
    getRecordActivity,
};
