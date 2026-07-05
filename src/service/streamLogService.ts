import { createWriteStream, WriteStream } from "fs";
import fs from "fs/promises";
import { join } from "path";
import { getLogDir } from "../util/logger";
import ormService from "./ormService";
import configService, { ConfigKey } from "./configService";
import { SgRecord } from "../model/sgRecord";

export async function prepareStreamLog(record: SgRecord): Promise<WriteStream | null> {
    const isStreamLogEnabled = ormService.isNode
        && (await configService.getConfig(ConfigKey.STREAM_LOG_ENABLED)).getBoolean();

    if (!isStreamLogEnabled) {
        return null;
    }

    const baseLogDir = getLogDir();
    const logDir = join(baseLogDir, "stream");
    console.log("[streamLogService] Stream log enabled, dir:", logDir);

    try {
        await fs.mkdir(logDir, { recursive: true });
    } catch (e: any) {
        console.log("[streamLogService] Failed to create log dir:", e);
        return null;
    }

    const logFilePath = join(logDir, `${record.id}.log`);
    console.log("[streamLogService] Stream log file path:", logFilePath);

    return createWriteStream(logFilePath, { flags: "a" });
}

export async function writeRequestLog(record: SgRecord, body: string): Promise<void> {
    const isStreamLogEnabled = ormService.isNode
        && (await configService.getConfig(ConfigKey.STREAM_LOG_ENABLED)).getBoolean();
    if (!isStreamLogEnabled) return;

    const logDir = join(getLogDir(), "stream");
    try {
        await fs.mkdir(logDir, { recursive: true });
    } catch (e: any) {
        console.log("[streamLogService] Failed to create log dir:", e);
        return;
    }

    const logFilePath = join(logDir, `${record.id}.after_convert_req.log`);
    const ws = createWriteStream(logFilePath);
    ws.end(body);
}

export function appendStreamLog(logStream: WriteStream | null, chunk: string): void {
    if (!logStream) {
        return;
    }

    console.log(
        "[streamLogService] Chunk length:",
        chunk.length,
        "contains \\n:",
        chunk.includes("\n"),
        "contains \\n\\n:",
        chunk.includes("\n\n"),
    );

    logStream.write(chunk);
}

export default {
    prepareStreamLog,
    writeRequestLog,
    appendStreamLog,
};
