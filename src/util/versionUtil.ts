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

export default {
    getVersion,
};
