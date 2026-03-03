import { randomUUID } from 'crypto'
import { getCurrentUpstreamConfig, isRealMode } from '../config'

/**
 * Mock Data Generator
 * Provides helper functions to generate test data
 */

/**
 * Generate a mock user
 */
export function generateUser(overrides: Partial<{ name: string; token: string }> = {}) {
  return {
    name: overrides.name || `Test User ${Date.now()}`,
    token: overrides.token || randomUUID(),
  }
}

/**
 * Generate a mock vendor
 */
export function generateVendor(overrides: Partial<{
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
    url: overrides.url || 'http://localhost:9999',
    api_format: overrides.api_format || 'openai',
  }
}

/**
 * Generate a mock OpenAI vendor
 */
export function generateOpenAIVendor() {
  const config = getCurrentUpstreamConfig()
  return generateVendor({
    type: 'other',
    name: isRealMode ? 'OpenAI' : 'Mock OpenAI',
    api_format: 'openai',
    url: config.openai.url,
    token: isRealMode ? config.openai.apiKey : `openai-token-${randomUUID()}`,
  })
}

/**
 * Generate a mock Anthropic vendor
 */
export function generateAnthropicVendor() {
  const config = getCurrentUpstreamConfig()
  return generateVendor({
    type: 'other',
    name: isRealMode ? 'Anthropic' : 'Mock Anthropic',
    api_format: 'anthropic',
    url: config.anthropic.url,
    token: isRealMode ? config.anthropic.apiKey : `anthropic-token-${randomUUID()}`,
  })
}

/**
 * Generate a mock model
 */
export function generateModel(vendorId: number, overrides: Partial<{ name: string }> = {}) {
  return {
    name: overrides.name || `test-model-${Date.now()}`,
    vendor_id: vendorId,
  }
}

/**
 * Generate a mock OpenAI chat request
 */
export function generateOpenAIChatRequest(overrides: Partial<{
  model: string
  messages: any[]
  stream: boolean
}> = {}) {
  const config = getCurrentUpstreamConfig()
  return {
    model: overrides.model || config.openai.model,
    messages: overrides.messages || [
      { role: 'user', content: 'Hello!' },
    ],
    stream: overrides.stream ?? false,
  }
}

/**
 * Generate a mock Anthropic messages request
 */
export function generateAnthropicMessageRequest(overrides: Partial<{
  model: string
  messages: any[]
  stream: boolean
  max_tokens: number
}> = {}) {
  const config = getCurrentUpstreamConfig()
  return {
    model: overrides.model || config.anthropic.model,
    messages: overrides.messages || [
      { role: 'user', content: 'Hello!' },
    ],
    stream: overrides.stream ?? false,
    max_tokens: overrides.max_tokens || 1024,
  }
}

/**
 * Generate a random string
 */
export function randomString(length: number = 10): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

/**
 * Generate a random number
 */
export function randomNumber(min: number = 1, max: number = 100): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/**
 * Generate a random email
 */
export function randomEmail(): string {
  return `${randomString(8).toLowerCase()}@example.com`
}
