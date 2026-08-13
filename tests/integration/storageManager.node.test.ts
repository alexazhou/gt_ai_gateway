import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import storageManager, { normalizeBytes, toDatabaseBytes } from "../../src/manager/storageManager";
import dbHelper from "../helpers/dbHelper";
import ormTestHelper from "../helpers/ormTestHelper";


describe("storageManager (node, real db)", () => {
    beforeAll(async () => {
        await ormTestHelper.connectNodeOrm();
    });

    beforeEach(async () => {
        await dbHelper.truncate();
    });

    it("putToTable create + getFromTable roundtrip", async () => {
        await storageManager.putToTable("k1", new Uint8Array([1, 2, 3]));
        const obj = await storageManager.getFromTable("k1");
        expect(obj?.object_key).toBe("k1");
        expect(obj?.size_bytes).toBe(3);
        expect(Array.from(obj!.data)).toEqual([1, 2, 3]);
    });

    it("putToTable updates existing row", async () => {
        await storageManager.putToTable("k1", new Uint8Array([1, 2, 3]));
        await storageManager.putToTable("k1", new Uint8Array([9, 8]));
        const obj = await storageManager.getFromTable("k1");
        expect(obj?.size_bytes).toBe(2);
        expect(Array.from(obj!.data)).toEqual([9, 8]);
    });

    it("getFromTable returns null for missing key", async () => {
        expect(await storageManager.getFromTable("missing")).toBeNull();
    });

    it("deleteFromTable + deleteFromTableByPrefix", async () => {
        await storageManager.putToTable("prefix-a", new Uint8Array([1]));
        await storageManager.putToTable("prefix-b", new Uint8Array([2]));
        await storageManager.putToTable("other-c", new Uint8Array([3]));

        const deleted = await storageManager.deleteFromTableByPrefix("prefix-");
        expect(deleted).toBe(2);
        expect(await storageManager.getFromTable("prefix-a")).toBeNull();
        expect(await storageManager.getFromTable("other-c")).not.toBeNull();

        await storageManager.deleteFromTable("other-c");
        expect(await storageManager.getFromTable("other-c")).toBeNull();
    });

    it("deleteFromTableByPrefix with no matches returns 0", async () => {
        expect(await storageManager.deleteFromTableByPrefix("nope-")).toBe(0);
    });
});

describe("normalizeBytes", () => {
    it("handles Uint8Array", () => {
        expect(normalizeBytes(new Uint8Array([1, 2]))).toEqual(new Uint8Array([1, 2]));
    });

    it("handles ArrayBuffer", () => {
        expect(normalizeBytes(new ArrayBuffer(2))).toEqual(new Uint8Array(2));
    });

    it("handles other TypedArray / DataView", () => {
        expect(normalizeBytes(new Uint16Array([1, 2]))).toEqual(new Uint8Array([1, 0, 2, 0]));
        const dv = new DataView(new ArrayBuffer(2));
        expect(normalizeBytes(dv)).toEqual(new Uint8Array(2));
    });

    it("handles string via TextEncoder", () => {
        expect(normalizeBytes("hi")).toEqual(new Uint8Array([104, 105]));
    });

    it("handles D1 Buffer serialized object", () => {
        expect(normalizeBytes({ type: "Buffer", data: [1, 2, 3] })).toEqual(new Uint8Array([1, 2, 3]));
    });

    it("ignores serialized object with non-Buffer type", () => {
        // type !== "Buffer" 时跳过 Buffer 反序列化分支，继续走后续分支并最终抛错
        expect(() => normalizeBytes({ type: "NotBuffer", data: [1, 2, 3] })).toThrow();
    });

    it("handles duck-typed buffer-like object", () => {
        const buf = new ArrayBuffer(2);
        expect(normalizeBytes({ buffer: buf, byteOffset: 0, byteLength: 2 })).toEqual(new Uint8Array(2));
    });

    it("handles plain array", () => {
        expect(normalizeBytes([1, 2, 3])).toEqual(new Uint8Array([1, 2, 3]));
    });

    it("handles number as single byte", () => {
        expect(normalizeBytes(7)).toEqual(new Uint8Array([7]));
    });

    it("handles null / undefined as empty", () => {
        expect(normalizeBytes(null)).toEqual(new Uint8Array(0));
        expect(normalizeBytes(undefined)).toEqual(new Uint8Array(0));
    });

    it("throws on unsupported type", () => {
        expect(() => normalizeBytes({})).toThrow();
        expect(() => normalizeBytes(true)).toThrow();
    });

    it("toDatabaseBytes returns Buffer when available", () => {
        const result = toDatabaseBytes(new Uint8Array([1, 2, 3]));
        expect(result).toBeInstanceOf(Uint8Array);
        expect(Array.from(result)).toEqual([1, 2, 3]);
    });

    it("toDatabaseBytes falls back to raw data when Buffer is undefined", () => {
        const originalBuffer = (globalThis as any).Buffer;
        (globalThis as any).Buffer = undefined;
        try {
            const input = new Uint8Array([4, 5]);
            const result = toDatabaseBytes(input);
            expect(result).toBe(input);
        } finally {
            (globalThis as any).Buffer = originalBuffer;
        }
    });
});
