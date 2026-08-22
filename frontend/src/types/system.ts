export const RunMode = {
    WORKER: 'worker',
    NODE: 'node',
} as const;

export type RunMode = typeof RunMode[keyof typeof RunMode];

export interface WelcomeResponse {
    user_type?: string;
}

export interface SystemStatusInfo {
    environment?: string;
    version?: string;
    apiAddress?: string;
    startTime?: string;
    uptime?: string;
    /** Node 模式下的进程内存占用（如 "128.5 MB"）；Worker 模式为 null */
    memory?: string | null;
    /** Worker 模式下本次请求的边缘数据中心（如 "SJC"）；Node 模式为 null */
    colo?: string | null;
}

export interface SystemStatistics {
    users?: number;
    vendors?: number;
    models?: number;
    records?: number;
}

export interface StorageStatus {
    r2_available?: boolean;
    r2_unavailable_reason?: string;
}

export interface StatusResponse {
    status?: string;
    mode?: RunMode;
    user_type?: string;
    system?: SystemStatusInfo;
    statistics?: SystemStatistics;
    modules?: {
        billing?: boolean;
        api_playground?: boolean;
        client_config?: boolean;
    };
    storage?: StorageStatus;
    timestamp?: string;
}

export interface UpdateStatusResponse {
    success: boolean;
    has_update: boolean;
    current_version: string;
    latest_version: string;
    release_url?: string;
    release_notes?: string;
    error_message?: string;
}
