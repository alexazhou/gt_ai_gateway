import type { TablePaginationConfig } from 'ant-design-vue';

// 通用类型定义
export type BaseResponse<T = unknown> = Record<string, T>;

export interface PaginationParams {
    page?: number;
    pageSize?: number;
}

export interface TableQuery extends PaginationParams {
    keyword?: string;
}

export interface TablePaginationState extends TablePaginationConfig {
    current: number;
    pageSize: number;
    total: number;
    showSizeChanger: boolean;
    showQuickJumper: boolean;
    pageSizeOptions: string[];
}

export interface BaseEntity {
    id: number;
    created_at: Date;
    updated_at: Date;
}
