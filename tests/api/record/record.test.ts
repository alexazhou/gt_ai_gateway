import { describe, it, expect, beforeAll } from 'vitest'
import { get, post } from '../../helpers/requestHelper'
import { generateUser } from '../../helpers/mockHelper'
import { VENDOR_FIXTURES } from '../../fixtures/vendorFixtures'
import { createRandomModel } from '../../fixtures/modelFixtures'
import { truncateDatabase } from '../../testHelpers'

/**
 * Record Endpoint Tests
 */

let testUserId: number
let testUserToken: string
let testVendorId: number
let testModelId: number

describe('Record API', () => {
  beforeAll(async () => {
    await truncateDatabase()

    // Create test user
    const user = await post('/user/create.json', generateUser())
    testUserId = user.body.id
    testUserToken = user.body.token

    // Create test vendor
    const vendor = await post('/vendor/create.json', VENDOR_FIXTURES.openai)
    testVendorId = vendor.body.id

    // Create test model
    const model = await post('/model/create.json', createRandomModel(testVendorId))
    testModelId = model.body.id
  })

  describe('GET /record/list.json', () => {
    it('should return a list of records', async () => {
      const response = await get('/record/list.json')

      expect(response.status).toBe(200)
      expect(Array.isArray(response.body)).toBe(true)
    })

    it('should return records with correct structure', async () => {
      const response = await get('/record/list.json')

      for (const record of response.body) {
        expect(record).toHaveProperty('id')
        expect(record).toHaveProperty('user_id')
        expect(record).toHaveProperty('model_id')
        expect(record).toHaveProperty('request_data')
        expect(record).toHaveProperty('response_data')
        expect(record).toHaveProperty('status')
        expect(record).toHaveProperty('created_at')
        expect(record).toHaveProperty('updated_at')
      }
    })
  })

  describe('GET /record/latest.json', () => {
    it('should return latest records with default limit', async () => {
      const response = await get('/record/latest.json')

      expect(response.status).toBe(200)
      expect(Array.isArray(response.body)).toBe(true)
    })

    it('should return latest records with specified limit', async () => {
      const response = await get('/record/latest.json?limit=5')

      expect(response.status).toBe(200)
      expect(Array.isArray(response.body)).toBe(true)
      expect(response.body.length).toBeLessThanOrEqual(5)
    })

    it('should return records sorted by created_at descending', async () => {
      const response = await get('/record/latest.json?limit=10')

      if (response.body.length > 1) {
        const timestamps = response.body.map((r: any) => new Date(r.created_at).getTime())

        for (let i = 1; i < timestamps.length; i++) {
          expect(timestamps[i - 1]).toBeGreaterThanOrEqual(timestamps[i])
        }
      }
    })
  })

  describe('GET /record/:id', () => {
    it('should return error for non-existent record ID initially', async () => {
      const response = await get('/record/99999')

      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(response.body).toHaveProperty('error')
    })

    it('should return error for invalid ID format', async () => {
      const response = await get('/record/invalid-id')

      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(response.body).toHaveProperty('error')
    })
  })
})
