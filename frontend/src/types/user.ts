import type { BaseEntity, TableQuery } from './index';

export type UserType = 'normal' | 'admin' | 'root';

/** 可通过用户接口分配的类型：root 仅由 ROOT_TOKEN 提供，不允许在后台授予 */
export type AssignableUserType = 'normal' | 'admin';

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
    type?: AssignableUserType;
}

export interface UpdateUserRequest {
    name?: string;
    token?: string;
    status?: 'active' | 'disabled';
    type?: AssignableUserType;
}

export interface UserQuery extends TableQuery {
    type?: UserType;
}

export interface AdjustBalanceRequest {
    amount: number;
    type: 'recharge' | 'adjustment';
    remark?: string;
}
