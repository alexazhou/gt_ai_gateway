import packageJson from "../../package.json";
import { getLogger } from "../util/loggerUtil";

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

// Memory cache for update status
let cachedStatus: UpdateStatus | null = null;
let lastCheckTime = 0;
const CHECK_INTERVAL = 1000 * 60 * 60 * 12; // 12 hours

async function checkUpdate(_ctx: any, force: boolean = false): Promise<UpdateStatus> {
    const currentVersion = packageJson.version;
    const now = Date.now();

    // Return cached status if within interval
    if (!force && cachedStatus && (now - lastCheckTime < CHECK_INTERVAL)) {
        return cachedStatus;
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

        const hasUpdate = isNewerVersion(currentVersion, latestVersion);

        const status: UpdateStatus = {
            success: true,
            has_update: hasUpdate,
            current_version: currentVersion,
            latest_version: latestVersion,
            release_url: release.html_url,
            release_notes: release.body,
        };

        // Cache the result
        cachedStatus = status;
        lastCheckTime = now;

        return status;
    } catch (e) {
        getLogger()?.warn(`[updateService] Error checking for updates: ${e}`);
        return {
            ...defaultStatus,
            error_message: String(e)
        };
    }
}

// Compare semantic versions (e.g. 1.2.3 < 1.2.4)
function isNewerVersion(current: string, latest: string): boolean {
    const currParts = current.split('.').map(Number);
    const latestParts = latest.split('.').map(Number);

    for (let i = 0; i < Math.max(currParts.length, latestParts.length); i++) {
        const curr = currParts[i] || 0;
        const lat = latestParts[i] || 0;
        if (lat > curr) return true;
        if (lat < curr) return false;
    }
    return false;
}

export default {
    checkUpdate
};
