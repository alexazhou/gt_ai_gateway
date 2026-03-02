import { describe, it, expect, beforeAll } from 'vitest'
import { post, postWithApiKey } from '../../helpers/requestHelper'
import { generateUser, generateAnthropicMessageRequest } from '../../helpers/mockHelper'
import { VENDOR_FIXTURES } from '../../fixtures/vendorFixtures'
import { createRandomModel } from '../../fixtures/modelFixtures'

/**
 * AI Messages Endpoint Tests (Anthropic)
 */

let testUserToken: string
let anthropicVendorId: number
let anthropicModelName: string

describe('AI Messages API (Anthropic)', () => {
  beforeAll(async () => {
    // Create test user
    const userResponse = await post('/user/create.json', generateUser())
    testUserToken = userResponse.body.token

    // Create Anthropic vendor
    const anthropicVendor = await post('/vendor/create.json', VENDOR_FIXTURES.anthropic)
    anthropicVendorId = anthropicVendor.body.id

    // Create Anthropic model
    const anthropicModel = await post('/model/create.json', createRandomModel(anthropicVendorId, 'claude-3-haiku-20240307'))
    anthropicModelName = anthropicModel.body.name
  })

  describe('POST /v1/messages', () => {
    it('should handle successful Anthropic message request with x-api-key', async () => {
      const messageRequest = generateAnthropicMessageRequest({
        model: anthropicModelName,
        stream: false,
      })

      const response = await postWithApiKey('/v1/messages', messageRequest, testUserToken)

      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('id')
      expect(response.body).toHaveProperty('type')
      expect(response.body.type).toBe('message')
      expect(response.body).toHaveProperty('role')
      expect(response.body.role).toBe('assistant')
      expect(response.body).toHaveProperty('content')
      expect(Array.isArray(response.body.content)).toBe(true)
      expect(response.body.content[0]).toHaveProperty('text')
      expect(response.body).toHaveProperty('model')
      expect(response.body).toHaveProperty('stop_reason')
      expect(response.body).toHaveProperty('usage')
    }, 30000)

    it('should handle successful Anthropic message request with Authorization header', async () => {
      const messageRequest = generateAnthropicMessageRequest({
        model: anthropicModelName,
        stream: false,
      })

      const response = await post('/v1/messages', messageRequest, testUserToken)

      expect(response.status).toBe(200)
      expect(response.body.type).toBe('message')
      expect(response.body.role).toBe('assistant')
    }, 30000)

    it('should handle streaming Anthropic message request', async () => {
      const messageRequest = generateAnthropicMessageRequest({
        model: anthropicModelName,
        stream: true,
      })

      const response = await postWithApiKey('/v1/messages', messageRequest, testUserToken)

      expect(response.status).toBe(200)
      expect(typeof response.body).toBe('string')
      expect(response.body).toContain('event:')
      expect(response.body).toContain('message_start')
      expect(response.body).toContain('content_block_delta')
      expect(response.body).toContain('message_stop')
    }, 30000)

    it('should handle multiple messages in request', async () => {
      const messageRequest = generateAnthropicMessageRequest({
        model: anthropicModelName,
        stream: false,
        messages: [
          { role: 'user', content: 'Hello!' },
          { role: 'assistant', content: 'Hi there!' },
          { role: 'user', content: 'How are you?' },
        ],
      })

      const response = await postWithApiKey('/v1/messages', messageRequest, testUserToken)

      expect(response.status).toBe(200)
      expect(response.body.type).toBe('message')
      expect(response.body.role).toBe('assistant')
    }, 30000)

    it('should handle custom max_tokens value', async () => {
      const messageRequest = generateAnthropicMessageRequest({
        model: anthropicModelName,
        stream: false,
        max_tokens: 512,
      })

      const response = await postWithApiKey('/v1/messages', messageRequest, testUserToken)

      expect(response.status).toBe(200)
      expect(response.body.type).toBe('message')
    }, 30000)
  })
})
