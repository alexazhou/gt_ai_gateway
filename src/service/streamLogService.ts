import { createWriteStream, WriteStream } from "fs";
import fs from "fs/promises";
import { join } from "path";
import { getLogDir, getLogger } from "../util/loggerUtil";
import ormService from "./ormService";
import configService from "./configService";
import { ConfigKey } from "../constants";
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
    } catch (e) {
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
    } catch (e) {
        console.log("[streamLogService] Failed to create log dir:", e);
        return;
    }

    const logFilePath = join(logDir, `${record.id}.after_convert_req.log`);
    const ws = createWriteStream(logFilePath);
    ws.end(body);
}

// 每个流已写入的 chunk 数（WeakMap：流对象被回收后计数自动消失，不会泄漏）
const chunkCounters = new WeakMap<WriteStream, number>();

// 采样间隔：流式响应轻松上千个 chunk，逐 chunk 打日志会把日志和事件循环都拖慢（P2-12）
const CHUNK_LOG_SAMPLE_EVERY = 200;


/**
 * 追加一段流日志。
 *
 * P2-12：原来每个 chunk 都 console.log 一次（还带两次 includes 扫描）——流式响应上千 chunk 时
 * 既是日志洪水又是热路径开销。改为采样（首个 + 每 200 个打一条），只保留「流有没有在动」的信号。
 */
export function appendStreamLog(logStream: WriteStream | null, chunk: string): void {
    if (!logStream) {
        return;
    }

    const written = (chunkCounters.get(logStream) ?? 0) + 1;
    chunkCounters.set(logStream, written);
    if (written === 1 || written % CHUNK_LOG_SAMPLE_EVERY === 0) {
        console.log(`[streamLogService] chunk #${written}, length: ${chunk.length}`);
    }

    logStream.write(chunk);
}


/**
 * 记录一段上游流式 chunk（应用日志分级 + 可选的独立流日志落盘）。
 *
 * - debug 级别：每个 chunk 都输出序号、长度与完整原文（排查上游分帧 / 字段缺失）；
 * - info 级别（默认）：只采样第 1 个与每 200 个一条摘要，只保留「流在动」的信号；
 * - warn/error 级别：控制台一条不打（采样摘要也属于 info）；
 * - 不论哪个级别，开了 stream_log_enabled（logStream 非空）就照常原样写入文件。
 *
 * 与 appendStreamLog 的区别：级别判定走 logger，序号由调用方（runSSELoop）给定，
 * 因此不需要 WeakMap 计数，也不依赖 logStream 是否存在。
 */
export function recordUpstreamChunk(
    recordId: number | string,
    chunkIndex: number,
    chunk: string,
    logStream: WriteStream | null,
): void {
    const logger = getLogger();
    // logger 未初始化（纯函数调用 / 单测）时按默认 info 处理
    if (logger?.isDebugEnabled()) {
        console.debug(`[streamLogService] [record=${recordId}] chunk #${chunkIndex} (length=${chunk.length}): ${chunk}`);
    } else if ((logger?.shouldLog("info") ?? true) && (chunkIndex === 1 || chunkIndex % CHUNK_LOG_SAMPLE_EVERY === 0)) {
        console.log(`[streamLogService] [record=${recordId}] chunk #${chunkIndex}, length: ${chunk.length}`);
    }

    if (logStream) {
        logStream.write(chunk);
    }
}


/**
 * 结束流日志并等待真正落盘（P2-12：原来只调 `end()` 不等待，
 * 进程/isolate 在 flush 前结束会丢掉尾部内容，排查时看到的日志是截断的）。
 */
export function finishStreamLog(logStream: WriteStream | null): Promise<void> {
    if (!logStream) {
        return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
        const done = () => resolve();
        logStream.once("close", done);
        logStream.once("finish", done);
        logStream.once("error", (e) => {
            // 日志落盘失败不能影响请求结果
            console.warn("[streamLogService] stream log write failed:", e);
            resolve();
        });
        logStream.end();
    });
}

export default {
    prepareStreamLog,
    writeRequestLog,
    appendStreamLog,
    recordUpstreamChunk,
    finishStreamLog,
};
