import packageJson from "../../package.json";

const ENV_KEY = "APP_VERSION";

/**
 * 获取软件版本号。
 *
 * 优先级：环境变量 APP_VERSION > 代码内置的 package.json version。
 * 二次开发时可通过 APP_VERSION 自定义要展示的版本号（如 "dev-20260821"）。
 *
 * @param env 可选：Cloudflare Workers 模式下绑定通过 Hono 的 c.env 传入，
 *            该参数让 worker 也能读取 APP_VERSION；不传则回退到 process.env。
 */
function getVersion(env?: Record<string, unknown> | null): string {
    const overridden = env?.[ENV_KEY] ?? process.env[ENV_KEY];
    if (typeof overridden === "string" && overridden.trim()) {
        return overridden.trim();
    }
    return packageJson.version;
}

// 解析版本号为"数值主干 + prerelease 后缀"。
// "v1.8.7-beta2" → { core: [1,8,7], prerelease: "beta2" }；"1.2.3" → { core: [1,2,3], prerelease: null }
function parseVersion(version: string): { core: number[]; prerelease: string | null } {
    const cleaned = version.replace(/^[vV]/, "").split("+", 1)[0];
    const [corePart, prerelease] = cleaned.split("-", 2);
    return {
        core: corePart.split(".").map(Number),
        prerelease: prerelease ?? null,
    };
}

/**
 * 按 semver 顺序比较两个版本号：先比数值主干（X.Y.Z），
 * 主干相同则带 prerelease 后缀的视为更旧（1.0.0 > 1.0.0-beta2）。
 * 返回负数 / 0 / 正数。
 */
function compareVersions(a: string, b: string): number {
    const va = parseVersion(a);
    const vb = parseVersion(b);
    const len = Math.max(va.core.length, vb.core.length);
    for (let i = 0; i < len; i++) {
        const x = va.core[i] || 0;
        const y = vb.core[i] || 0;
        if (x !== y) return x - y;
    }
    // 数值主干相同：无 prerelease 视为更新
    const rank = (p: string | null) => (p ? 0 : 1);
    return rank(va.prerelease) - rank(vb.prerelease);
}

// latest 是否比 current 新
function isNewerVersion(current: string, latest: string): boolean {
    return compareVersions(latest, current) > 0;
}

export default {
    getVersion,
    isNewerVersion,
};
