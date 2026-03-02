import { globalSetup, globalTeardown } from './globalSetup'

beforeAll(async () => {
  await globalSetup()
}, 60000)

afterAll(async () => {
  await globalTeardown()
}, 60000)
