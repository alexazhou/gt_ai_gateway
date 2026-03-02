import { describe, it, expect, beforeAll } from 'vitest'
import { post, postWithApiKey } from '../../helpers/requestHelper'
import { generateUser, generateOpenAIChatRequest, generateAnthropicMessageRequest } from '../../helpers/mockHelper'
import { VENDOR_FIXTURES } from '../../fixtures/vendorFixtures'
import { createRandomModel } from '../../fixtures/modelFixtures'
import { truncateDatabase } from '../../testHelpers'

/**
 * AI Endpoint Negative Tests
 */

let testUserToken: string
let openaiVendorId: number
let anthropicVendorId: number
let openaiModelName: string
let anthropicModelName: string

describe('AI Chat API (Negative)', () => {
  beforeAll(async () => {
    await truncateDatabase()

    // Create test user
    const userResponse = await post('/user/create.json', generateUser())
    testUserToken = userResponse.body.token

    // Create OpenAI vendor
    const openaiVendor = await post('/vendor/create.json', VENDOR_FIXTURES.openai)
    openaiVendorId = openaiVendor.body.id

    // Create Anthropic vendor
    const anthropicVendor = await post('/vendor/create.json', VENDOR_FIXTURES.anthropic)
    anthropicVendorId = anthropicVendor.body.id

    // Create OpenAI model
    const openaiModel = await post('/model/create.json', createRandomModel(openaiVendorId, 'gpt-3.5-turbo'))
    openaiModelName = openaiModel.body.name

    // Create Anthropic model
    const anthropicModel = await post('/model/create.json', createRandomModel(anthropicVendorId, 'claude-3-haiku-20240307'))
    anthropicModelName = anthropicModel.body.name
  })

  describe('POST /v1/chat/completions', () => {
    it('should return 401 when Authorization header is missing', async () => {
      const chatRequest = generateOpenAIChatRequest({ model: openaiModelName })

      const response = await post('/v1/chat/completions', chatRequest, undefined)

      expect(response.status).toBe(401)
      expect(response.body).toHaveProperty('error')
      expect(response.body.error).toContain('Authorization')
    }, 30000)

    it('should return 401 when token is invalid', async () => {
      const chatRequest = generateOpenAIChatRequest({ model: openaiModelName })

      const response = await post('/v1/chat/completions', chatRequest, 'invalid-token-12345')

      expect(response.status).toBe(401)
      expect(response.body).toHaveProperty('error')
      expect(response.body.error).toContain('user not found')
    }, 30000)

    it('should return 401 when model does not exist', async () => {
      const chatRequest = generateOpenAIChatRequest({ model: 'non-existent-model' })

      const response = await post('/v1/chat/completions', chatRequest, testUserToken)

      expect(response.status).toBe(401)
      expect(response.body).toHaveProperty('error')
      expect(response.body.error).toContain('model not found')
    }, 30000)
  })

  describe('POST /v1/messages (Anthropic)', () => {
    it('should return 401 when x-api-key header is missing', async () => {
      const messageRequest = generateAnthropicMessageRequest({ model: anthropicModelName })

      const response = await post('/v1/messages', messageRequest, undefined)

      expect(response.status).toBe(401)
      expect(response.body).toHaveProperty('error')
      expect(response.body.error).toContain('x-api-key')
    }, 30000)

    it('should return 401 when token is invalid', async () => {
      const messageRequest = generateAnthropicMessageRequest({ model: anthropicModelName })

      const response = await postWithApiKey('/v1/messages', messageRequest, 'invalid-token-12345')

      expect(response.status).toBe(401)
      expect(response.body).toHaveProperty('error')
      expect(response.body.error).toContain('user not found')
    }, 30000)

    it('should return 401 when model does not exist', async () => {
      const messageRequest = generateAnthropicMessageRequest({ model: 'non-existent-model' })

      const response = await postWithApiKey('/v1/messages', messageRequest, testUserToken)

      expect(response.status).toBe(401)
      expect(response.body).toHaveProperty('error')
      expect(response.body.error).toContain('model not found')
    }, 30000)
  })
})
