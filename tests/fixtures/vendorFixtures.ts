import { randomUUID } from 'crypto'

/**
 * Vendor Test Data Fixtures
 */

export const VENDOR_FIXTURES = {
  openai: {
    type: 'other',
    name: 'Mock OpenAI',
    token: `openai-token-${randomUUID()}`,
    url: 'http://localhost:9999/chat/completions',
    api_format: 'openai',
  },
  anthropic: {
    type: 'other',
    name: 'Mock Anthropic',
    token: `anthropic-token-${randomUUID()}`,
    url: 'http://localhost:9999/messages',
    api_format: 'anthropic',
  },
  custom: {
    type: 'other',
    name: 'Custom Vendor',
    token: `custom-token-${randomUUID()}`,
    url: 'https://api.custom.com/v1/chat',
    api_format: 'openai',
  },
  aliyun: {
    type: 'aliyun',
    name: 'Aliyun Vendor',
    token: `aliyun-token-${randomUUID()}`,
    url: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
    api_format: 'openai',
  },
  deepseek: {
    type: 'deepseek',
    name: 'DeepSeek Vendor',
    token: `deepseek-token-${randomUUID()}`,
    url: 'https://api.deepseek.com/v1/chat/completions',
    api_format: 'openai',
  },
}

export function createRandomVendor(overrides: Partial<{
  type: string
  name: string
  token: string
  url: string
  api_format: string
}> = {}) {
  return {
    type: overrides.type || 'other',
    name: overrides.name || `Test Vendor ${Date.now()}`,
    token: overrides.token || `vendor-token-${randomUUID()}`,
    url: overrides.url || 'https://api.example.com/v1/chat',
    api_format: overrides.api_format || 'openai',
  }
}
