import request from '../utils/request';
import type { ListResult } from '../types';
import type {
    Rule,
    RuleQuery,
    CreateRuleRequest,
    UpdateRuleRequest,
    PluginDescriptor,
} from '../types/rule';

export async function listRules(params?: RuleQuery): Promise<ListResult<Rule>> {
    return request.get('/rule/list.json', { params });
}

/** 可用请求插件清单（后端插件注册表描述，按名字升序） */
export async function listPlugins(): Promise<PluginDescriptor[]> {
    return request.get('/rule/plugins.json');
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
