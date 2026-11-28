import { existsSync, mkdirSync, writeFileSync, appendFileSync, statSync, readdirSync, renameSync, unlinkSync } from "fs";
import { join } from "path";

export type LogLevel = "debug" | "info" | "warn" | "error";

// 级别越高越严重；低于 minLevel 的日志既不落盘也不进控制台
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

const DEFAULT_LOG_LEVEL: LogLevel = "info";

/**
 * 解析日志级别：大小写不敏感，空值或非法值一律回退 info（存量 config 没有该字段时不至于静默丢日志）。
 */
export function parseLogLevel(raw?: string | null): LogLevel {
    const value = (raw ?? "").trim().toLowerCase();
    return value in LOG_LEVEL_PRIORITY ? (value as LogLevel) : DEFAULT_LOG_LEVEL;
}

// 保存原始 console 方法，避免被重写导致无限递归
const originalConsole = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    debug: console.debug,
};

// 默认轮转参数：单文件最大 100MB，最多保留 5 个 app-*.log 文件
const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024;
const DEFAULT_MAX_FILE_COUNT = 5;

// app-YYYY-MM-DD.log 或 app-YYYY-MM-DD.N.log
const APP_LOG_PATTERN = /^app-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.log$/;

interface LoggerOptions {
    /** 单文件最大字节数，超过后轮转。默认 100MB */
    maxFileSize?: number;
    /** 保留的 app-*.log 文件数量上限，超出时删除最旧的。默认 5 */
    maxFileCount?: number;
    /** 最小输出级别，默认取环境变量 LOG_LEVEL，再缺省则 info */
    level?: LogLevel;
}

class Logger {
    private logDir: string;
    private logFilePath: string = "";
    private currentDateStr: string = "";
    private currentSize: number = 0;
    private enabled: boolean;
    private readonly maxFileSize: number;
    private readonly maxFileCount: number;
    private minLevel: LogLevel;
    /** 跨天切换后要补一次 prune（新一天的文件此时还没建，只能等写入后清） */
    private pendingPrune: boolean = false;

    constructor(logDir: string, enabled: boolean = true, options?: LoggerOptions) {
        this.logDir = logDir;
        this.enabled = enabled;
        this.maxFileSize = options?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
        this.maxFileCount = options?.maxFileCount ?? DEFAULT_MAX_FILE_COUNT;
        this.minLevel = options?.level ?? parseLogLevel(process.env.LOG_LEVEL);

        if (enabled) {
            this.ensureLogDir();
            this.logFilePath = this.getLogFilePath();
            this.currentSize = this.getFileSize(this.logFilePath);
            // 启动时清一次：按天滚动时 rotate() 不会触发，历史文件会无限累积
            this.pruneOldFiles();
        }
    }

    /** 当前生效的最小输出级别 */
    getLevel(): LogLevel {
        return this.minLevel;
    }

    setLevel(level: LogLevel): void {
        this.minLevel = level;
    }

    /** 该级别是否达到输出阈值 */
    shouldLog(level: LogLevel): boolean {
        return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.minLevel];
    }

    /** 是否开启了 debug：流式 chunk 的逐条原文输出靠它判定 */
    isDebugEnabled(): boolean {
        return this.minLevel === "debug";
    }

    private ensureLogDir(): void {
        if (!existsSync(this.logDir)) {
            mkdirSync(this.logDir, { recursive: true });
        }
    }

    private getTodayStr(): string {
        return new Date().toISOString().split("T")[0];
    }

    private getLogFilePath(): string {
        this.currentDateStr = this.getTodayStr();
        return join(this.logDir, `app-${this.currentDateStr}.log`);
    }

    private getFileSize(path: string): number {
        try {
            return statSync(path).size;
        } catch {
            return 0;
        }
    }

    private formatTimestamp(): string {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, "0");
        const day = String(now.getDate()).padStart(2, "0");
        const hours = String(now.getHours()).padStart(2, "0");
        const minutes = String(now.getMinutes()).padStart(2, "0");
        const seconds = String(now.getSeconds()).padStart(2, "0");
        const milliseconds = String(now.getMilliseconds()).padStart(3, "0");

        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${milliseconds}`;
    }

    /**
     * 计算今天的下一个轮转序号（app-DATE.N.log 中的 N）。
     */
    private nextRotationSeq(): number {
        const prefix = `app-${this.currentDateStr}.`;
        const suffix = ".log";
        let maxSeq = 0;
        try {
            for (const name of readdirSync(this.logDir)) {
                if (!name.startsWith(prefix) || !name.endsWith(suffix)) {
                    continue;
                }
                const seqStr = name.slice(prefix.length, -suffix.length);
                const seq = Number(seqStr);
                if (Number.isFinite(seq) && seq > maxSeq) {
                    maxSeq = seq;
                }
            }
        } catch {
            // ignore
        }
        return maxSeq + 1;
    }

    /**
     * 当前文件达到大小上限时，轮转为 app-DATE.N.log，并重新开始一个空的活动文件。
     */
    private rotate(): void {
        if (!existsSync(this.logFilePath) || this.currentSize < this.maxFileSize) {
            return;
        }

        const seq = this.nextRotationSeq();
        const rotatedPath = join(this.logDir, `app-${this.currentDateStr}.${seq}.log`);
        try {
            renameSync(this.logFilePath, rotatedPath);
        } catch (e) {
            // 轮转失败则继续写入原文件，避免丢日志
            originalConsole.warn("[logger] Failed to rotate log file:", e);
            return;
        }

        // 重建空的活动文件并重置计数
        writeFileSync(this.logFilePath, "");
        this.currentSize = 0;

        this.pruneOldFiles();
    }

    /**
     * 只保留最新的 maxFileCount 个 app-*.log 文件，删除其余的。
     * 永远保留当前活动文件。
     */
    private pruneOldFiles(): void {
        let files: { name: string; mtime: number }[] = [];
        try {
            files = readdirSync(this.logDir)
                .filter((name) => APP_LOG_PATTERN.test(name))
                .map((name) => {
                    let mtime = 0;
                    try {
                        mtime = statSync(join(this.logDir, name)).mtimeMs;
                    } catch {
                        // ignore
                    }
                    return { name, mtime };
                });
        } catch {
            return;
        }

        // 按修改时间倒序，保留最新的 maxFileCount 个
        files.sort((a, b) => b.mtime - a.mtime);
        const surplus = files.slice(this.maxFileCount);
        for (const { name } of surplus) {
            const fullPath = join(this.logDir, name);
            if (fullPath === this.logFilePath) {
                // 永不删除当前活动文件
                continue;
            }
            try {
                unlinkSync(fullPath);
            } catch (e) {
                originalConsole.warn("[logger] Failed to delete old log file:", name, e);
            }
        }
    }

    /**
     * 跨天时切换到新一天的活动文件。
     */
    private rollOverIfNewDay(): void {
        const today = this.getTodayStr();
        if (today === this.currentDateStr) {
            return;
        }
        this.logFilePath = this.getLogFilePath();
        this.currentSize = this.getFileSize(this.logFilePath);
        this.pendingPrune = true;
    }

    private write(level: LogLevel, message: string, ...args: unknown[]): void {
        if (!this.enabled || !this.shouldLog(level)) {
            return;
        }

        this.rollOverIfNewDay();
        this.rotate();

        const timestamp = this.formatTimestamp();
        const prefix = `[${timestamp}] [${level.toUpperCase()}]`;

        const formattedArgs = args.map((arg) => {
            if (typeof arg === "object") {
                return JSON.stringify(arg, null, 2);
            }
            return String(arg);
        });

        const logLine = `${prefix} ${message}${formattedArgs.length > 0 ? " " + formattedArgs.join(" ") : ""}\n`;

        appendFileSync(this.logFilePath, logLine);
        this.currentSize += Buffer.byteLength(logLine, "utf8");

        // 跨天后的第一条日志落盘时文件才存在，这时清理才能把新文件算进保留名额
        if (this.pendingPrune) {
            this.pendingPrune = false;
            this.pruneOldFiles();
        }
    }

    info(message: string, ...args: unknown[]): void {
        if (!this.shouldLog("info")) return;
        this.write("info", message, ...args);
        originalConsole.log(`[INFO] ${message}`, ...args);
    }

    warn(message: string, ...args: unknown[]): void {
        if (!this.shouldLog("warn")) return;
        this.write("warn", message, ...args);
        originalConsole.warn(`[WARN] ${message}`, ...args);
    }

    error(message: string, ...args: unknown[]): void {
        if (!this.shouldLog("error")) return;
        this.write("error", message, ...args);
        originalConsole.error(`[ERROR] ${message}`, ...args);
    }

    debug(message: string, ...args: unknown[]): void {
        if (!this.shouldLog("debug")) return;
        this.write("debug", message, ...args);
        originalConsole.debug(`[DEBUG] ${message}`, ...args);
    }
}

let loggerInstance: Logger | null = null;

function initLogger(rootDirOrEnabled?: string | boolean, enabled?: boolean, options?: LoggerOptions): Logger {
    if (!loggerInstance) {
        let logDir: string;
        let isLoggerEnabled: boolean = true;

        // 支持两种调用方式：
        // 1. initLogger(enabled: boolean)
        // 2. initLogger(rootDir: string, enabled: boolean)
        if (typeof rootDirOrEnabled === "string") {
            logDir = rootDirOrEnabled;
            isLoggerEnabled = enabled ?? true;
        } else {
            logDir = getLogDir();
            isLoggerEnabled = rootDirOrEnabled ?? true;
        }

        loggerInstance = new Logger(logDir, isLoggerEnabled, options);
    }
    return loggerInstance;
}

function getLogger(): Logger | null {
    return loggerInstance;
}

function resetLogger(): void {
    loggerInstance = null;
}

/**
 * 获取日志目录路径
 * 优先使用环境变量 LOG_DIR，否则使用项目根目录下的 log
 * @returns 日志目录路径
 */
function getLogDir(): string {
    return process.env.LOG_DIR || join(process.cwd(), "log");
}

export default initLogger;
export { getLogger, Logger, resetLogger, getLogDir, LOG_LEVEL_PRIORITY, DEFAULT_LOG_LEVEL };
