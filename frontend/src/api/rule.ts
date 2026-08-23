import request from '../utils/request';
import type { ListResult } from '../types';
import type { Rule, RuleQuery, CreateRuleRequest, UpdateRuleRequest } from '../types/rule';

export async function listRules(params?: RuleQuery): Promise<ListResult<Rule>> {
    return request.get('/rule/list.json', { params });
}

export async function getRule(id: number): Promise<Rule> {
    return request.get(`/rule/${id}`);
}

export async function createRule(data: CreateRuleRequest): Promise<Rule> {
    return request.post('/rule/create.json', data);
}

export async function updateRule(id: number, data: UpdateRuleRequest): Promise<Rule> {
    return request.put(`/rule/${id}`, data);
}

export async function deleteRule(id: number): Promise<{ success: boolean }> {
    return request.delete(`/rule/${id}`);
}
