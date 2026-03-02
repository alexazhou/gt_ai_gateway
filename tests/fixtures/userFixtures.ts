import { randomUUID } from 'crypto'

/**
 * User Test Data Fixtures
 */

export const USER_FIXTURES = {
  basic: {
    name: 'Test User',
    token: randomUUID(),
  },
  withCustomToken: {
    name: 'Test User with Custom Token',
    token: 'custom-token-123',
  },
  duplicateName1: {
    name: 'Duplicate User',
    token: randomUUID(),
  },
  duplicateName2: {
    name: 'Duplicate User',
    token: randomUUID(),
  },
  longName: {
    name: 'A'.repeat(255),
    token: randomUUID(),
  },
  emptyToken: {
    name: 'Test User',
    token: '',
  },
}

export function createRandomUser(name?: string, token?: string) {
  return {
    name: name || `Test User ${Date.now()}`,
    token: token || randomUUID(),
  }
}
