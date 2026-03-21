import type { Record } from './record';

export interface DashboardStats {
    total_requests: number;
    success_count: number;
    failed_count: number;
    success_rate: number | null;
    active_users: number;
    active_models: number;
    today_requests: number;
}

export type RecentRecord = Record;

export interface TimeRangeStats {
    date: string;
    count: number;
    success_count: number;
    failed_count: number;
}
