import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import objectStorageService from "../../src/service/objectStorageService";
import ormService from "../../src/service/ormService";
import configService from "../../src/service/configService";
import { ConfigKey, RunMode } from "../../src/constants";
import dbHelper from "../helpers/dbHelper";
import ormTestHelper from "../helpers/ormTestHelper";

function createMockR2Bucket(): R2Bucket {
    const objects = new Map<string, Uint8Array>();

    return {
        put: vi.fn(async (key: string, value: unknown) => {
            if (value instanceof Uint8Array) {
                objects.set(key, new Uint8Array(value));
                return null;
            }
            if (value instanceof ArrayBuffer) {
                objects.set(key, new Uint8Array(value));
                return null;
            }
            throw new Error("unsupported mock R2 value");
        }),
        get: vi.fn(async (key: string) => {
            const value = objects.get(key);
            if (!value) {
                return null;
            }
            const copy = new Uint8Array(value);
            return {
                arrayBuffer: async () => copy.buffer.slice(
                    copy.byteOffset,
                    copy.byteOffset + copy.byteLength,
                ),
            };
        }),
        delete: vi.fn(async (keys: string | string[]) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
                objects.delete(key);
            }
        }),
        list: vi.fn(async (options?: R2ListOptions) => {
            const limit = options?.limit ?? 1000;
            const start = options?.cursor ? Number(options.cursor) : 0;
            const allKeys = [...objects.keys()]
                .filter(key => !options?.prefix || key.startsWith(options.prefix))
                .sort();
            const pageKeys = allKeys.slice(start, start + limit);
            const next = start + limit;
            const objectsPage = pageKeys.map(key => ({ key }) as R2Object);

            if (next < allKeys.length) {
                return {
                    objects: objectsPage,
                    delimitedPrefixes: [],
                    truncated: true,
                    cursor: String(next),
                } as R2Objects;
            }

            return {
                objects: objectsPage,
                delimitedPrefixes: [],
                truncated: false,
            } as R2Objects;
        }),
    } as unknown as R2Bucket;
}

async function getStoredDatabaseObject(key: string): Promise<{ object_key: string; data: Buffer } | null> {
    const rows = await dbHelper.query<{ object_key: string; data: Buffer }>(
        "SELECT object_key, data FROM storage_record WHERE object_key = ?",
        [key],
    );
    return rows[0] ?? null;
}

describe("objectStorageService", () => {
    const originalMode = ormService.mode;

    beforeAll(async () => {
        await ormTestHelper.connectNodeOrm();
    });

    beforeEach(async () => {
        vi.restoreAllMocks();
        objectStorageService.setR2Bucket(null);
        ormService.mode = RunMode.NODE;
        await dbHelper.truncate();
    });

    afterEach(() => {
        objectStorageService.setR2Bucket(null);
        ormService.mode = originalMode;
        vi.restoreAllMocks();
    });

    it("stores and reads binary data in database mode", async () => {
        const key = "object-storage/binary";
        const data = new Uint8Array([0, 1, 2, 255]);

        await objectStorageService.put(key, data);

        const stored = await objectStorageService.get(key);
        expect(Array.from(stored!)).toEqual([0, 1, 2, 255]);
    });

    it("overwrites existing database objects by key", async () => {
        const key = "object-storage/overwrite";

        await objectStorageService.put(key, new Uint8Array([1, 2, 3]));
        await objectStorageService.put(key, new Uint8Array([9, 8]));

        const stored = await objectStorageService.get(key);
        expect(Array.from(stored!)).toEqual([9, 8]);
    });

    it("stores empty binary data in database mode", async () => {
        const key = "object-storage/empty";

        await objectStorageService.put(key, new Uint8Array());

        const stored = await objectStorageService.get(key);
        expect(stored).not.toBeNull();
        expect(stored!.byteLength).toBe(0);
    });

    it("supports text helpers and delete in database mode", async () => {
        const key = "object-storage/text";

        await objectStorageService.putText(key, "hello 数据");

        expect(await objectStorageService.getText(key)).toBe("hello 数据");

        await objectStorageService.delete(key);

        expect(await objectStorageService.get(key)).toBeNull();
    });

    it("deletes database objects by prefix", async () => {
        await objectStorageService.put("record/clear-a", new Uint8Array([1]));
        await objectStorageService.put("recording/clear-b", new Uint8Array([2]));
        await objectStorageService.put("other/clear-c", new Uint8Array([3]));

        const cleared = await objectStorageService.deleteByPrefix("record/");

        expect(cleared).toBe(1);
        expect(await objectStorageService.get("record/clear-a")).toBeNull();
        expect(Array.from((await objectStorageService.get("recording/clear-b"))!)).toEqual([2]);
        expect(Array.from((await objectStorageService.get("other/clear-c"))!)).toEqual([3]);
    });

    it("uses R2 in worker mode", async () => {
        const bucket = createMockR2Bucket();
        ormService.mode = RunMode.WORKER;
        objectStorageService.setR2Bucket(bucket);

        await objectStorageService.put("worker/object", new Uint8Array([5, 6, 7]));

        const stored = await objectStorageService.get("worker/object");
        expect(Array.from(stored!)).toEqual([5, 6, 7]);
        expect(bucket.put).toHaveBeenCalledWith("worker/object", expect.any(Uint8Array));
        expect(bucket.get).toHaveBeenCalledWith("worker/object");

        await objectStorageService.delete("worker/object");
        expect(await objectStorageService.get("worker/object")).toBeNull();
    });

    it("deletes R2 objects by prefix in worker mode", async () => {
        const bucket = createMockR2Bucket();
        ormService.mode = RunMode.WORKER;
        objectStorageService.setR2Bucket(bucket);

        await objectStorageService.put("record/clear-a", new Uint8Array([1]));
        await objectStorageService.put("recording/clear-b", new Uint8Array([2]));
        await objectStorageService.put("other/clear-c", new Uint8Array([3]));

        const cleared = await objectStorageService.deleteByPrefix("record/");

        expect(cleared).toBe(1);
        expect(bucket.list).toHaveBeenCalledWith({ cursor: undefined, limit: 1000, prefix: "record/" });
        expect(bucket.delete).toHaveBeenCalledWith(["record/clear-a"]);
        expect(await objectStorageService.get("record/clear-a")).toBeNull();
        expect(Array.from((await objectStorageService.get("recording/clear-b"))!)).toEqual([2]);
        expect(Array.from((await objectStorageService.get("other/clear-c"))!)).toEqual([3]);
    });

    it("requires an R2 bucket when R2 storage is explicitly configured", async () => {
        ormService.mode = RunMode.WORKER;
        objectStorageService.setR2Bucket(null);
        await configService.setValue(ConfigKey.RECORD_PAYLOAD_STORAGE, "r2");

        await expect(objectStorageService.get("worker/missing-bucket"))
            .rejects
            .toThrow("R2 object bucket is not configured");
    });

    it("uses database storage in auto mode when worker mode has no R2 bucket", async () => {
        const key = "auto/worker-without-r2";
        ormService.mode = RunMode.WORKER;
        objectStorageService.setR2Bucket(null);
        await configService.setValue(ConfigKey.RECORD_PAYLOAD_STORAGE, "auto");

        await objectStorageService.putText(key, "database-value");

        const row = await getStoredDatabaseObject(key);
        expect(row).not.toBeNull();
        expect(row!.object_key).toBe(key);
        expect(row!.data.toString()).toBe("database-value");
        expect(await objectStorageService.getText(key)).toBe("database-value");
    });

    it("uses database storage in auto mode outside worker even when a bucket is available", async () => {
        const bucket = createMockR2Bucket();
        ormService.mode = RunMode.NODE;
        objectStorageService.setR2Bucket(bucket);
        await configService.setValue(ConfigKey.RECORD_PAYLOAD_STORAGE, "auto");

        await objectStorageService.putText("auto/node", "database-value");

        expect(bucket.put).not.toHaveBeenCalled();
        expect(await objectStorageService.getText("auto/node")).toBe("database-value");
    });

    it("uses database storage in worker mode when configured", async () => {
        const bucket = createMockR2Bucket();
        ormService.mode = RunMode.WORKER;
        objectStorageService.setR2Bucket(bucket);
        await configService.setValue(ConfigKey.RECORD_PAYLOAD_STORAGE, "database");

        await objectStorageService.putText("configured/database", "database-value");

        expect(bucket.put).not.toHaveBeenCalled();
        expect(await objectStorageService.getText("configured/database")).toBe("database-value");
    });

    it("uses R2 storage in node mode when configured and a bucket is available", async () => {
        const bucket = createMockR2Bucket();
        ormService.mode = RunMode.NODE;
        objectStorageService.setR2Bucket(bucket);
        await configService.setValue(ConfigKey.RECORD_PAYLOAD_STORAGE, "r2");

        await objectStorageService.putText("configured/r2", "r2-value");

        expect(bucket.put).toHaveBeenCalledWith("configured/r2", expect.any(Uint8Array));
        expect(await objectStorageService.getText("configured/r2")).toBe("r2-value");
    });

    it("falls back to the other storage location when reading existing data", async () => {
        const bucket = createMockR2Bucket();
        ormService.mode = RunMode.NODE;
        objectStorageService.setR2Bucket(bucket);
        await configService.setValue(ConfigKey.RECORD_PAYLOAD_STORAGE, "database");
        await objectStorageService.putText("configured/fallback", "database-value");

        await configService.setValue(ConfigKey.RECORD_PAYLOAD_STORAGE, "r2");

        expect(await objectStorageService.getText("configured/fallback")).toBe("database-value");
    });

    it("removes stale copies from the other storage location when writing", async () => {
        const bucket = createMockR2Bucket();
        ormService.mode = RunMode.NODE;
        objectStorageService.setR2Bucket(bucket);
        await configService.setValue(ConfigKey.RECORD_PAYLOAD_STORAGE, "database");
        await objectStorageService.putText("configured/moved", "database-old");

        await configService.setValue(ConfigKey.RECORD_PAYLOAD_STORAGE, "r2");
        await objectStorageService.putText("configured/moved", "r2-new");

        await configService.setValue(ConfigKey.RECORD_PAYLOAD_STORAGE, "database");

        expect(await objectStorageService.getText("configured/moved")).toBe("r2-new");
    });

    it("deletes matching objects from both storage locations", async () => {
        const bucket = createMockR2Bucket();
        ormService.mode = RunMode.NODE;
        objectStorageService.setR2Bucket(bucket);

        await configService.setValue(ConfigKey.RECORD_PAYLOAD_STORAGE, "database");
        await objectStorageService.putText("record/database-payload", "database-value");

        await configService.setValue(ConfigKey.RECORD_PAYLOAD_STORAGE, "r2");
        await objectStorageService.putText("record/r2-payload", "r2-value");

        const deleted = await objectStorageService.deleteByPrefix("record/");

        expect(deleted).toBe(2);
        expect(await objectStorageService.getText("record/database-payload")).toBeNull();
        expect(await objectStorageService.getText("record/r2-payload")).toBeNull();
    });
});
