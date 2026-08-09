import type { BaseEntity, TableQuery } from './index';

export type UserType = 'normal' | 'admin' | 'root';

export interface User extends BaseEntity {
    name: string;
    token: string;
    type: UserType;
    balance: number; // 后端返回整数微元（1 元 = 1000000 微元），展示时除以 BALANCE_SCALE
    status: 'active' | 'disabled';
}

export interface CreateUserRequest {
    name: string;
    token?: string;
    type?: UserType;
}

export interface UpdateUserRequest {
    name?: string;
    token?: string;
    status?: 'active' | 'disabled';
}

export interface UserQuery extends TableQuery {
    type?: UserType;
}

export interface AdjustBalanceRequest {
    amount: number;
    type: 'recharge' | 'adjustment';
    remark?: string;
}
