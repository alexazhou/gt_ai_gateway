import { describe, it, expect, beforeAll } from 'vitest'
import { get, post } from '../../helpers/requestHelper'
import { generateUser } from '../../helpers/mockHelper'
import { USER_FIXTURES } from '../../fixtures/userFixtures'

/**
 * User Endpoint Positive Tests
 */

let createdUserId: number
let createdUserToken: string

describe('User API (Positive)', () => {
  describe('POST /user/create.json', () => {
    it('should create a user with specified token', async () => {
      const userData = USER_FIXTURES.withCustomToken
      const response = await post('/user/create.json', userData)

      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('id')
      expect(response.body.name).toBe(userData.name)
      expect(response.body.token).toBe(userData.token)
      expect(response.body).toHaveProperty('created_at')
      expect(response.body).toHaveProperty('updated_at')

      createdUserId = response.body.id
      createdUserToken = response.body.token
    })

    it('should create a user with auto-generated token when token is not provided', async () => {
      const userData = { name: 'Auto Token User' }
      const response = await post('/user/create.json', userData)

      expect(response.status).toBe(200)
      expect(response.body).toHaveProperty('id')
      expect(response.body.name).toBe(userData.name)
      expect(response.body.token).toBeTruthy()
      expect(typeof response.body.token).toBe('string')
      expect(response.body.token.length).toBeGreaterThan(0)
    })

    it('should create multiple users with the same name', async () => {
      const userData1 = generateUser({ name: 'Same Name User' })
      const userData2 = generateUser({ name: 'Same Name User' })

      const response1 = await post('/user/create.json', userData1)
      const response2 = await post('/user/create.json', userData2)

      expect(response1.status).toBe(200)
      expect(response2.status).toBe(200)
      expect(response1.body.name).toBe(response2.body.name)
      expect(response1.body.id).not.toBe(response2.body.id)
    })

    it('should handle long names', async () => {
      const userData = USER_FIXTURES.longName
      const response = await post('/user/create.json', userData)

      expect(response.status).toBe(200)
      expect(response.body.name).toBe(userData.name)
    })

    it('should handle empty token', async () => {
      const userData = USER_FIXTURES.emptyToken
      const response = await post('/user/create.json', userData)

      expect(response.status).toBe(200)
      expect(response.body.token).toBe(userData.token)
    })
  })

  describe('GET /user/list.json', () => {
    it('should return a list of users', async () => {
      const response = await get('/user/list.json')

      expect(response.status).toBe(200)
      expect(Array.isArray(response.body)).toBe(true)
      expect(response.body.length).toBeGreaterThan(0)
    })

    it('should return users with correct structure', async () => {
      const response = await get('/user/list.json')
      const user = response.body[0]

      expect(user).toHaveProperty('id')
      expect(user).toHaveProperty('name')
      expect(user).toHaveProperty('token')
      expect(user).toHaveProperty('created_at')
      expect(user).toHaveProperty('updated_at')
    })

    it('should return all users created in tests', async () => {
      const response = await get('/user/list.json')

      expect(response.body.length).toBeGreaterThanOrEqual(4) // At least the users we created
    })
  })

  describe('GET /user/:id', () => {
    it('should return a user by ID', async () => {
      const response = await get(`/user/${createdUserId}`)

      expect(response.status).toBe(200)
      expect(response.body.id).toBe(createdUserId)
      expect(response.body.token).toBe(createdUserToken)
      expect(response.body).toHaveProperty('name')
    })

    it('should return user with all fields', async () => {
      const response = await get(`/user/${createdUserId}`)

      expect(response.body).toHaveProperty('id')
      expect(response.body).toHaveProperty('name')
      expect(response.body).toHaveProperty('token')
      expect(response.body).toHaveProperty('created_at')
      expect(response.body).toHaveProperty('updated_at')
    })
  })
})
