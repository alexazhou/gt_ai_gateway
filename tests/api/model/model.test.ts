import { describe, it, expect, beforeAll } from 'vitest'
import { get, post } from '../../helpers/requestHelper'
import { VENDOR_FIXTURES, createRandomVendor } from '../../fixtures/vendorFixtures'
import { createRandomModel } from '../../fixtures/modelFixtures'
import { truncateDatabase } from '../../testHelpers'

/**
 * Model Endpoint Positive Tests
 */

let openaiVendorId: number
let anthropicVendorId: number
let createdModelId: number

describe('Model API (Positive)', () => {
  beforeAll(async () => {
    await truncateDatabase()

    // Create vendors for model tests
    const openaiVendor = await post('/vendor/create.json', VENDOR_FIXTURES.openai)
    openaiVendorId = openaiVendor.body.id

    const anthropicVendor = await post('/vendor/create.json', VENDOR_FIXTURES.anthropic)
    anthropicVendorId = anthropicVendor.body.id
  })

  describe('POST /model/create.json', () => {
    it('should create a model linked to OpenAI vendor', async () => {
      const modelData = createRandomModel(openaiVendorId, 'gpt-3.5-turbo')
      const response = await post('/model/create.json', modelData)

      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('id')
      expect(response.body.name).toBe('gpt-3.5-turbo')
      expect(response.body.vendor_id).toBe(openaiVendorId)
      expect(response.body).toHaveProperty('created_at')
      expect(response.body).toHaveProperty('updated_at')

      createdModelId = response.body.id
    })

    it('should create a model linked to Anthropic vendor', async () => {
      const modelData = createRandomModel(anthropicVendorId, 'claude-3-haiku-20240307')
      const response = await post('/model/create.json', modelData)

      expect(response.status).toBe(200)
      expect(response.body.name).toBe('claude-3-haiku-20240307')
      expect(response.body.vendor_id).toBe(anthropicVendorId)
    })

    it('should create a random model', async () => {
      const modelData = createRandomModel(openaiVendorId)
      const response = await post('/model/create.json', modelData)

      expect(response.status).toBe(200)
      expect(response.body.vendor_id).toBe(openaiVendorId)
      expect(response.body.name).toBeTruthy()
    })
  })

  describe('GET /model/list.json', () => {
    it('should return a list of models', async () => {
      const response = await get('/model/list.json')

      expect(response.status).toBe(200)
      expect(Array.isArray(response.body)).toBe(true)
      expect(response.body.length).toBeGreaterThan(0)
    })

    it('should return models with correct structure', async () => {
      const response = await get('/model/list.json')
      const model = response.body[0]

      expect(model).toHaveProperty('id')
      expect(model).toHaveProperty('name')
      expect(model).toHaveProperty('vendor_id')
      expect(model).toHaveProperty('created_at')
      expect(model).toHaveProperty('updated_at')
    })

    it('should include models from different vendors', async () => {
      const response = await get('/model/list.json')

      const vendorIds = response.body.map((m: any) => m.vendor_id)
      expect(vendorIds).toContain(openaiVendorId)
      expect(vendorIds).toContain(anthropicVendorId)
    })
  })
})
