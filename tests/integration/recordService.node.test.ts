import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SgRecord } from "../../src/model/sgRecord";
import recordService from "../../src/service/recordService";
import objectStorageService from "../../src/service/objectStorageService";
import { SgRecordStatus, ConfigKey } from "../../src/constants";
import configService from "../../src/service/configService";
import dbHelper from "../helpers/dbHelper";
import ormTestHelper from "../helpers/ormTestHelper";


describe("recordService (node, real db)", () => {
    beforeAll(async () => {
        await ormTestHelper.connectNodeOrm();
    });

    beforeEach(async () => {
        await dbHelper.truncate();
    });

    async function getStoredPayload(recordId: number) {
        const raw = await objectStorageService.getText(`record/${recordId}`);
        return raw ? JSON.parse(raw) : null;
    }

    async function getRecordRow(recordId: number) {
        const rows = await dbHelper.query<any>(
            "SELECT id FROM record WHERE id = ?",
            [recordId],
        );
        return rows[0] ?? null;
    }

    async function getRecordColumns(): Promise<string[]> {
        if (process.env.DB_DRIVER === "mysql") {
            // MySQL：information_schema.columns 列出列名
            const rows = await dbHelper.query<{ COLUMN_NAME: string }>(
                "SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'record'",
            );
            return rows.map((r) => r.COLUMN_NAME);
        }
        const rows = await dbHelper.query<{ name: string }>(
            "PRAGMA table_info(record)",
        );
        return rows.map((r) => r.name);
    }

    it("drops the legacy request_data / response_data columns from the record table", async () => {
        const columns = await getRecordColumns();
        expect(columns).not.toContain("request_data");
        expect(columns).not.toContain("response_data");
    });

    it("create writes the request payload to object storage, not the record table", async () => {
        const record = await recordService.create(1, 1, '{"hello":"world"}');

        const payload = await getStoredPayload(Number(record.id));
        expect(payload).toEqual({ request: '{"hello":"world"}', response: null });

        // record row exists but the payload columns are gone
        const row = await getRecordRow(Number(record.id));
        expect(row).not.toBeNull();
    });

    it("create with null request stores a null request payload", async () => {
        const record = await recordService.create(1, 1, null);

        const payload = await getStoredPayload(Number(record.id));
        expect(payload).toEqual({ request: null, response: null });
    });

    it("update with response_data merges into storage and keeps it out of the record table", async () => {
        const record = await recordService.create(1, 1, '{"q":1}');

        await recordService.update(Number(record.id), {
            response_data: '{"a":2}',
            status: SgRecordStatus.SUCCESS,
        });

        const payload = await getStoredPayload(Number(record.id));
        expect(payload).toEqual({ request: '{"q":1}', response: '{"a":2}' });

        const row = await getRecordRow(Number(record.id));
        expect(row).not.toBeNull();
        // status still updated on the record table
        const refreshed = await SgRecord.query().find(Number(record.id));
        expect(refreshed!.status).toBe(SgRecordStatus.SUCCESS);
    });

    it("update without response_data does not touch object storage", async () => {
        const record = await recordService.create(1, 1, '{"q":1}');

        await recordService.update(Number(record.id), {
            status: SgRecordStatus.PROCESSING,
        });

        // payload unchanged
        const payload = await getStoredPayload(Number(record.id));
        expect(payload).toEqual({ request: '{"q":1}', response: null });
    });

    it("attachPayload loads request/response onto the record from storage", async () => {
        const record = await recordService.create(1, 1, '{"q":1}');
        await recordService.update(Number(record.id), {
            response_data: 'plain error',
            status: SgRecordStatus.FAILED,
        });

        const fresh = await SgRecord.query().find(Number(record.id));
        await recordService.attachPayload(fresh!);

        expect(fresh!.request_data).toBe('{"q":1}');
        // non-JSON response preserved as raw string
        expect(fresh!.response_data).toBe('plain error');
    });

    it("latest (non-summary) attaches payloads to each record", async () => {
        const r1 = await recordService.create(1, 1, '{"q":1}');
        const r2 = await recordService.create(1, 1, '{"q":2}');
        await recordService.update(Number(r2.id), {
            response_data: '{"a":2}',
            status: SgRecordStatus.SUCCESS,
        });

        const records = await recordService.latest(10, false);
        const byId = new Map(records.map((r: any) => [Number(r.id), r]));

        const first = byId.get(Number(r1.id));
        expect(first.request_data).toBe('{"q":1}');
        expect(first.response_data).toBeNull();

        const second = byId.get(Number(r2.id));
        expect(second.request_data).toBe('{"q":2}');
        expect(second.response_data).toBe('{"a":2}');
    });

    it("should not log when RECORD_LOG_ENABLED is false", async () => {
        process.env.RECORD_LOG_ENABLED = "false";
        const spy = vi.spyOn(console, "log").mockImplementation(() => {});

        await recordService.create(1, 1, "test request");
        expect(spy).not.toHaveBeenCalled();

        await recordService.update(1, { status: "success" as any });
        expect(spy).not.toHaveBeenCalled();

        spy.mockRestore();
        delete process.env.RECORD_LOG_ENABLED;
    });

    it("should log when RECORD_LOG_ENABLED is true", async () => {
        process.env.RECORD_LOG_ENABLED = "true";
        const spy = vi.spyOn(console, "log").mockImplementation(() => {});

        await recordService.create(1, 1, "test request");
        expect(spy).toHaveBeenCalledWith(expect.stringContaining("[RecordService] Creating record: user=1, model=1"));
        expect(spy).toHaveBeenCalledWith(expect.stringContaining("test request"));

        await recordService.update(1, { status: "success" as any });
        expect(spy).toHaveBeenCalledWith(
            expect.stringContaining("[RecordService] Updating record 1:"),
            expect.any(String),
        );

        spy.mockRestore();
        delete process.env.RECORD_LOG_ENABLED;
    });

    it("skips storage write on create when payload recording is disabled", async () => {
        await configService.setValue(ConfigKey.RECORD_PAYLOAD_ENABLED, "false");

        const record = await recordService.create(1, 1, "test request");

        const payload = await getStoredPayload(Number(record.id));
        expect(payload).toBeNull();
    });

    it("skips storage write on update with response_data when payload recording is disabled", async () => {
        const record = await recordService.create(1, 1, '{"q":1}');
        await configService.setValue(ConfigKey.RECORD_PAYLOAD_ENABLED, "false");

        await recordService.update(Number(record.id), {
            response_data: "resp body",
            status: SgRecordStatus.SUCCESS,
        });

        // payload unchanged — response not written
        const payload = await getStoredPayload(Number(record.id));
        expect(payload).toEqual({ request: '{"q":1}', response: null });
    });
});
