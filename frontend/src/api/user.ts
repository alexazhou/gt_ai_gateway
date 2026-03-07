import request from '@/utils/request';
import type { User, CreateUserRequest, UserQuery } from '@/types/user';

export function listUsers(query?: UserQuery): Promise<User[]> {
    return request.get('/user/list.json', { params: query });
}

export function getUser(id: number): Promise<User> {
    return request.get(`/user/${id}`);
}

export function createUser(data: CreateUserRequest): Promise<User> {
    return request.post('/user/create.json', data);
}

export function updateUser(id: number, data: Partial<CreateUserRequest>): Promise<User> {
    return request.put(`/user/${id}`, data);
}

export function deleteUser(id: number): Promise<void> {
    return request.delete(`/user/${id}`);
}
