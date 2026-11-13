import { parse as smolParse, stringify } from "smol-toml";
import objectUtil from "./objectUtil";


function buildTomlString(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}


function parse(content: string): Record<string, unknown> {
    return smolParse(content) as Record<string, unknown>;
}


/**
 * Clean up duplicate keys in TOML content.
 * TOML parsers throw on duplicate keys, so we need to clean them first.
 */
function cleanDuplicateKeys(content: string): string {
    const lines = content.split("\n");
    const seenKeys = new Set<string>();
    let currentTable = "";
    const result: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim();

        // Track table headers
        const tableMatch = trimmed.match(/^\[([^\]]+)\]$/);
        if (tableMatch) {
            currentTable = tableMatch[1];
            result.push(line);
            continue;
        }

        // Skip empty lines and comments
        if (!trimmed || trimmed.startsWith("#")) {
            result.push(line);
            continue;
        }

        // Check for key = value pattern
        const keyMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*=/);
        if (keyMatch) {
            const key = keyMatch[1];
            const fullKey = currentTable ? `${currentTable}.${key}` : key;

            if (seenKeys.has(fullKey)) {
                // Skip duplicate key
                continue;
            }
            seenKeys.add(fullKey);
        }

        result.push(line);
    }

    return result.join("\n");
}


function safeParse(content: string): Record<string, unknown> {
    if (!content.trim()) {
        return {};
    }
    const cleaned = cleanDuplicateKeys(content);
    return parse(cleaned);
}


function getTomlValue(content: string, key: string): string | null {
    try {
        const doc = safeParse(content);
        const value = doc[key];
        if (typeof value === "string") {
            return value;
        }
        return null;
    } catch {
        return null;
    }
}


function getTomlTableValue(content: string, tableName: string, key: string): string | null {
    try {
        const doc = safeParse(content);
        const parts = tableName.split(".");
        let current: unknown = doc;

        for (const part of parts) {
            if (objectUtil.isRecord(current) && part in current) {
                current = current[part];
            } else {
                return null;
            }
        }

        if (objectUtil.isRecord(current) && key in current) {
            const value = current[key];
            if (typeof value === "string") {
                return value;
            }
        }
        return null;
    } catch {
        return null;
    }
}


function deleteTomlTable(content: string, tableName: string): string {
    try {
        const doc = safeParse(content);
        const parts = tableName.split(".");

        if (parts.length === 1) {
            delete doc[parts[0]];
        } else if (parts.length === 2) {
            const parent = doc[parts[0]];
            if (objectUtil.isRecord(parent)) {
                delete parent[parts[1]];
            }
        }

        return stringify(doc);
    } catch {
        return content;
    }
}


function deleteRootTomlValue(content: string, key: string): string {
    if (!content.trim()) {
        return content;
    }

    try {
        const doc = safeParse(content);
        delete doc[key];
        return stringify(doc);
    } catch {
        return content;
    }
}


function upsertRootTomlValue(content: string, key: string, value: string): string {
    try {
        const doc = safeParse(content);
        const parsedValue = value.replace(/^"|"$/g, "");
        doc[key] = parsedValue;
        return stringify(doc);
    } catch {
        return content;
    }
}


function upsertTomlTable(content: string, tableName: string, values: Record<string, string>): string {
    try {
        const doc = safeParse(content);
        const parts = tableName.split(".");
        let current: Record<string, unknown> = doc;

        // Navigate to the parent of the target table
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            const next = current[part];
            if (objectUtil.isRecord(next)) {
                current = next;
            } else {
                const created: Record<string, unknown> = {};
                current[part] = created;
                current = created;
            }
        }

        const tableName2 = parts[parts.length - 1];
        const existingTarget = current[tableName2];
        const target: Record<string, unknown> = objectUtil.isRecord(existingTarget) ? existingTarget : {};
        current[tableName2] = target;

        // Set values (remove quotes for string values)
        for (const [key, value] of Object.entries(values)) {
            target[key] = value.replace(/^"|"$/g, "");
        }

        return stringify(doc);
    } catch {
        return content;
    }
}


export default {
    buildTomlString,
    cleanDuplicateKeys,
    deleteRootTomlValue,
    deleteTomlTable,
    getTomlTableValue,
    getTomlValue,
    parse,
    upsertRootTomlValue,
    upsertTomlTable,
};
