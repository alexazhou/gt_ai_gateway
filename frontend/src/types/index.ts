// 通用类型定义
export interface BaseResponse<T = any> {
    [key: string]: T;
}

export interface PaginationParams {
    page?: number;
    pageSize?: number;
}

export interface TableQuery extends PaginationParams {
    keyword?: string;
}

export interface BaseEntity {
    id: number;
    created_at: Date;
    updated_at: Date;
}
