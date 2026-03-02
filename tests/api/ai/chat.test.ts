import { describe, it, expect, beforeAll } from 'vitest'
import { post } from '../../helpers/requestHelper'
import { generateUser, generateOpenAIChatRequest, generateAnthropicMessageRequest } from '../../helpers/mockHelper'
import { VENDOR_FIXTURES } from '../../fixtures/vendorFixtures'
import { createRandomModel } from '../../fixtures/modelFixtures'

/**
 * AI Chat Endpoint Tests
 */

let testUserToken: string
let openaiVendorId: number
let anthropicVendorId: number
let openaiModelName: string
let anthropicModelName: string

describe('AI Chat API', () => {
  beforeAll(async () => {
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
    it('should handle successful OpenAI chat request', async () => {
      const chatRequest = generateOpenAIChatRequest({
        model: openaiModelName,
        stream: false,
      })

      const response = await post('/v1/chat/completions', chatRequest, testUserToken)

      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('id')
      expect(response.body).toHaveProperty('object')
      expect(response.body.object).toBe('chat.completion')
      expect(response.body).toHaveProperty('created')
      expect(response.body).toHaveProperty('model')
      expect(response.body).toHaveProperty('choices')
      expect(Array.isArray(response.body.choices)).toBe(true)
      expect(response.body.choices[0]).toHaveProperty('message')
      expect(response.body.choices[0].message.role).toBe('assistant')
      expect(response.body.choices[0].message.content).toBeTruthy()
      expect(response.body).toHaveProperty('usage')
    }, 30000)

    it('should handle streaming OpenAI chat request', async () => {
      const chatRequest = generateOpenAIChatRequest({
        model: openaiModelName,
        stream: true,
      })

      const response = await post('/v1/chat/completions', chatRequest, testUserToken)

      expect(response.status).toBe(200)
      expect(typeof response.body).toBe('string')
      expect(response.body).toContain('data:')
      expect(response.body).toContain('chat.completion.chunk')
      expect(response.body).toContain('[DONE]')
    }, 30000)

    it('should handle multiple messages in chat request', async () => {
      const chatRequest = generateOpenAIChatRequest({
        model: openaiModelName,
        stream: false,
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Hello!' },
          { role: 'assistant', content: 'Hi there!' },
          { role: 'user', content: 'How are you?' },
        ],
      })

      const response = await post('/v1/chat/completions', chatRequest, testUserToken)

      expect(response.status).toBe(200)
      expect(response.body.choices[0].message.role).toBe('assistant')
    }, 30000)
  })
})
