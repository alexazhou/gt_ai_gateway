import { describe, it, expect } from "vitest";
import { canonicalMigrationName } from "../../../src/util/db/dbAdapter";

describe("dbAdapter.canonicalMigrationName", () => {
    it("归一化旧版文件名记录（migrate_XXXX.sql → migrate_XXXX）", () => {
        expect(canonicalMigrationName("migrate_0001.sql")).toBe("migrate_0001");
        expect(canonicalMigrationName("migrate_0028.sql")).toBe("migrate_0028");
    });

    it("对规范目录名原样返回", () => {
        expect(canonicalMigrationName("migrate_0001")).toBe("migrate_0001");
        expect(canonicalMigrationName("migrate_0029")).toBe("migrate_0029");
    });

    it("仅去掉尾部 .sql 后缀，其余名字不做改动", () => {
        expect(canonicalMigrationName("migrate_0001.sql.bak")).toBe("migrate_0001.sql.bak");
        expect(canonicalMigrationName("schema.sql")).toBe("schema");
    });
});