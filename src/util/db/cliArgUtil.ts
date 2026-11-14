/**
 * 子进程参数白名单校验（命令注入防线的一部分）。
 *
 * 依赖：调用方一律用 `execFileSync(cmd, argv[])` 以独立参数传值（不进 shell），
 * 本文件只是第二道防线：把「明显不该出现在 argv 里的值」（路径穿越、分号、空白、
 * 命令替换等）提前拒掉，避免非法输入变成意外行为。
 *
 * 用于 wrangler d1 CLI 的 dbName / configPath 等标识符与路径参数。
 */
const SAFE_ARG_PATTERN = /^[\w./-]+$/;

export function isSafeCliArg(value: string): boolean {
    if (!value) {
        return true; // 空串表示"未配置"，由调用方决定是否使用
    }
    if (!SAFE_ARG_PATTERN.test(value)) {
        return false;
    }
    // 拒绝路径穿越片段（`..`）
    return !value.split("/").some((seg) => seg === "..");
}

/**
 * 校验会进入子进程 argv 的参数；非法值直接抛错（不降级、不静默过滤）。
 */
export function assertSafeCliArg(value: string, label: string): void {
    if (!isSafeCliArg(value)) {
        throw new Error(`Invalid ${label} for wrangler d1 execute: ${value}`);
    }
}

export default {
    isSafeCliArg,
    assertSafeCliArg,
};
