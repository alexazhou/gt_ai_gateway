import { describe, it, expect } from 'vitest'
import { get } from '../../helpers/requestHelper'

/**
 * System Endpoint Tests
 */

describe('System API', () => {
  describe('GET /', () => {
    it('should return welcome message with status 200', async () => {
      const response = await get('/')

      expect(response.status).toBe(200)
      expect(response.body).toContain('Hello')
      expect(response.body).toContain('serverless ai gateway')
    })

    it('should return a text response', async () => {
      const response = await get('/')

      expect(typeof response.body).toBe('string')
      expect(response.headers.get('content-type')).toContain('text/plain')
    })

    it('should indicate local mode', async () => {
      const response = await get('/')

      expect(response.body).toContain('local mode')
    })
  })
})
