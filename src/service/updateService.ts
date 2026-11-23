import packageJson from "../../package.json";
import { getLogger } from "../util/loggerUtil";
import versionUtil from "../util/versionUtil";
import stateStoreService from "./stateStoreService";

interface GitHubRelease {
    tag_name: string;
    html_url: string;
    body: string;
    published_at: string;
}

interface UpdateStatus {
    success: boolean;
    has_update: boolean;
    current_version: string;
    latest_version: string;
    release_url?: string;
    release_notes?: string;
    error_message?: string;
}

/** 版本检查结果缓存（纯可丢缓存语义：丢了只是多打一次 GitHub API） */
const UPDATE_CACHE_KEY = "sys:update:latest";
const CHECK_INTERVAL = 1000 * 60 * 60 * 12; // 12 hours

/**
 * 读取缓存。fail-open：StateStore 不可用（`StateStoreUnavailableError`）或内容损坏时
 * 一律当作「没有缓存」，让调用方继续走在线检查 —— 版本检查是纯优化，不能因为它挂了就报错。
 */
async function readCache(): Promise<UpdateStatus | null> {
    try {
        const raw = await stateStoreService.getStore().get(UPDATE_CACHE_KEY);
        if (raw === null) {
            return null;
        }
        const parsed = JSON.parse(raw) as UpdateStatus;
        // 结构对不上（老版本写进来的形状 / 人为破坏）也按未命中处理
        if (typeof parsed?.latest_version !== "string") {
            return null;
        }
        return parsed;
    } catch (e) {
        getLogger()?.warn(`[updateService] 读取版本检查缓存失败（fail-open，继续在线检查）: ${e}`);
        return null;
    }
}

/** 写缓存。fail-open：写失败只记日志，不影响本次结果返回。 */
async function writeCache(status: UpdateStatus): Promise<void> {
    try {
        await stateStoreService.getStore().set(UPDATE_CACHE_KEY, JSON.stringify(status), {
            ttlMs: CHECK_INTERVAL,
        });
    } catch (e) {
        getLogger()?.warn(`[updateService] 写入版本检查缓存失败（fail-open）: ${e}`);
    }
}

async function checkUpdate(force: boolean = false): Promise<UpdateStatus> {
    const currentVersion = packageJson.version;

    // force=true 跳过缓存直接问 GitHub；否则先看缓存（TTL 12h 由 StateStore 负责）
    if (!force) {
        const cached = await readCache();
        if (cached) {
            return cached;
        }
    }

    const defaultStatus: UpdateStatus = {
        success: false,
        has_update: false,
        current_version: currentVersion,
        latest_version: currentVersion,
    };

    try {
        const response = await fetch("https://api.github.com/repos/alexazhou/gt_ai_gateway/releases/latest", {
            headers: {
                "User-Agent": `Serverless-AI-Gateway/${currentVersion}`,
                "Accept": "application/vnd.github.v3+json"
            }
        });

        if (!response.ok) {
            getLogger()?.warn(`[updateService] Failed to fetch latest release: ${response.status}`);
            return {
                ...defaultStatus,
                error_message: `获取新版本失败，状态码: ${response.status}`
            };
        }

        const release = await response.json() as GitHubRelease;
        let latestVersion = release.tag_name;

        // Remove 'v' prefix if exists
        if (latestVersion.startsWith('v')) {
            latestVersion = latestVersion.substring(1);
        }

        const hasUpdate = versionUtil.isNewerVersion(currentVersion, latestVersion);

        const status: UpdateStatus = {
            success: true,
            has_update: hasUpdate,
            current_version: currentVersion,
            latest_version: latestVersion,
            release_url: release.html_url,
            release_notes: release.body,
        };

        // Cache the result（失败不影响返回）
        await writeCache(status);

        return status;
    } catch (e) {
        getLogger()?.warn(`[updateService] Error checking for updates: ${e}`);
        return {
            ...defaultStatus,
            error_message: String(e)
        };
    }
}

export default {
    checkUpdate
};
