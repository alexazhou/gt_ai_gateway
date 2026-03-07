import type { BaseEntity, TableQuery } from './index';

export type UserType = 'normal' | 'admin';

export interface User extends BaseEntity {
    name: string;
    token: string;
    type: UserType;
}

export interface CreateUserRequest {
    name: string;
    token?: string;
    type?: UserType;
}

export interface UserQuery extends TableQuery {
    type?: UserType;
}
