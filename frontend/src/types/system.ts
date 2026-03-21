export interface WelcomeResponse {
    user_type?: string;
}

export interface SystemStatusInfo {
    environment?: string;
    version?: string;
    startTime?: string;
}

export interface SystemStatistics {
    records?: number;
}

export interface StatusResponse {
    system?: SystemStatusInfo;
    statistics?: SystemStatistics;
}
