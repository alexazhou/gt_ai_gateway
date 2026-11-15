import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SgRecordStatus, RunMode } from "../../../src/constants";
import { SgRecord } from "../../../src/model/sgRecord";
import objectStorageService from "../../../src/service/objectStorageService";
import ormService from "../../../src/service/ormService";
import recordService from "../../../src/service/recordService";
import dbHelper from "../../helpers/dbHelper";
import ormTestHelper from "../../helpers/ormTestHelper";


describe("record payload service integration", () => {
    beforeAll(async () => {
        await ormTestHelper.connectNodeOrm();
    });

    beforeEach(async () => {
        ormService.mode = RunMode.NODE;
        objectStorageService.setR2Bucket(null);
        await dbHelper.truncate();
    });

    it("objectStorageService.deleteByPrefix deletes only record payload keys", async () => {
        await objectStorageService.putText("record/clear-a", "record-a");
        await objectStorageService.putText("record/clear-b", "record-b");
        await objectStorageService.putText("recording/keep-a", "recording-a");
        await objectStorageService.putText("other/keep-b", "other-b");

        const cleared = await objectStorageService.deleteByPrefix("record/");

        expect(cleared).toBe(2);
        expect(await objectStorageService.getText("record/clear-a")).toBeNull();
        expect(await objectStorageService.getText("record/clear-b")).toBeNull();
        expect(await objectStorageService.getText("recording/keep-a")).toBe("recording-a");
        expect(await objectStorageService.getText("other/keep-b")).toBe("other-b");
    });

    it("recordService.clearPayloads clears payloads while keeping records", async () => {
        const first = await recordService.create(1, 1, '{"q":1}');
        await recordService.update(Number(first.id), {
            response_data: '{"a":1}',
            status: SgRecordStatus.SUCCESS,
        });
        const second = await recordService.create(1, 1, '{"q":2}');
        await objectStorageService.putText("recording/keep-service", "keep");

        const before = await SgRecord.query().find(Number(first.id));
        await recordService.attachPayload(before!);
        expect(before!.request_data).toBe('{"q":1}');
        expect(before!.response_data).toBe('{"a":1}');

        const cleared = await recordService.clearPayloads();

        expect(cleared).toBe(2);
        expect(await SgRecord.query().find(Number(first.id))).not.toBeNull();
        expect(await SgRecord.query().find(Number(second.id))).not.toBeNull();
        expect(await objectStorageService.getText("recording/keep-service")).toBe("keep");

        const firstAfter = await SgRecord.query().find(Number(first.id));
        const secondAfter = await SgRecord.query().find(Number(second.id));
        await recordService.attachPayload(firstAfter!);
        await recordService.attachPayload(secondAfter!);

        expect(firstAfter!.request_data).toBeNull();
        expect(firstAfter!.response_data).toBeNull();
        expect(secondAfter!.request_data).toBeNull();
        expect(secondAfter!.response_data).toBeNull();
    });
});
