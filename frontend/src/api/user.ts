import request from '../utils/request';
import type { User, CreateUserRequest, UpdateUserRequest, AdjustBalanceRequest } from '../types/user';
import type { UserQuery } from '../types/user';

export async function listUsers(params?: UserQuery): Promise<User[]> {
    return request.get('/user/list.json', { params });
}

export async function fetchUsersByIds(ids: number[]): Promise<User[]> {
    return request.post('/user/batch.json', { ids });
}

export async function getUser(id: number): Promise<User> {
    return request.get(`/user/${id}`);
}

export async function createUser(data: CreateUserRequest): Promise<User> {
    return request.post('/user/create.json', data);
}

export async function updateUser(id: number, data: UpdateUserRequest): Promise<User> {
    return request.put(`/user/${id}`, data);
}

export async function adjustUserBalance(id: number, data: AdjustBalanceRequest): Promise<User> {
    return request.post(`/user/${id}/balance/adjust.json`, data);
}
