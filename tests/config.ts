import { join } from 'path'

/**
 * Test Configuration
 * Supports environment variables for flexible test configuration
 */

const PROJECT_ROOT = process.cwd()

/**
 * Server Configuration
 */
export const SERVER_CONFIG = {
  baseUrl: process.env.TEST_BASE_URL || 'http://localhost:3000',
  port: parseInt(process.env.TEST_PORT || '3000', 10),
}

/**
 * Database Configuration
 */
export const DB_CONFIG = {
  path: process.env.TEST_DB_PATH || join(PROJECT_ROOT, 'test.db'),
  mode: process.env.TEST_DB_MODE || 'local',
}

/**
 * Upstream Service Configuration
 */
export const UPSTREAM_CONFIG = {
  openai: {
    enabled: process.env.TEST_UPSTREAM_OPENAI_ENABLED === 'true',
    url: process.env.TEST_UPSTREAM_OPENAI_URL || 'https://api.openai.com/v1/chat/completions',
    apiKey: process.env.TEST_UPSTREAM_OPENAI_API_KEY || '',
    model: process.env.TEST_UPSTREAM_OPENAI_MODEL || 'gpt-3.5-turbo',
  },
  anthropic: {
    enabled: process.env.TEST_UPSTREAM_ANTHROPIC_ENABLED === 'true',
    url: process.env.TEST_UPSTREAM_ANTHROPIC_URL || 'https://api.anthropic.com/v1/messages',
    apiKey: process.env.TEST_UPSTREAM_ANTHROPIC_API_KEY || '',
    model: process.env.TEST_UPSTREAM_ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
  },
  mock: {
    enabled: process.env.TEST_UPSTREAM_MOCK_ENABLED !== 'false',
    url: process.env.TEST_UPSTREAM_MOCK_URL || 'http://localhost:9999',
  },
}

/**
 * Test Options
 */
export const TEST_OPTIONS = {
  cleanup: process.env.TEST_CLEANUP !== 'false',
  timeout: parseInt(process.env.TEST_TIMEOUT || '30000', 10),
  verbose: process.env.TEST_VERBOSE === 'true',
}

/**
 * Check if real upstream services are configured
 */
export const hasRealUpstream = UPSTREAM_CONFIG.openai.enabled || UPSTREAM_CONFIG.anthropic.enabled

/**
 * Check if mock server is enabled
 */
export const useMockServer = UPSTREAM_CONFIG.mock.enabled

/**
 * Logging helper for verbose mode
 */
export function logTest(...args: any[]) {
  if (TEST_OPTIONS.verbose) {
    console.log('[TEST]', ...args)
  }
}

export default {
  SERVER_CONFIG,
  DB_CONFIG,
  UPSTREAM_CONFIG,
  TEST_OPTIONS,
  hasRealUpstream,
  useMockServer,
  logTest,
}
