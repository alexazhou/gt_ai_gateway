import { Context } from 'hono'
import { DatabaseAdapter } from '../service/dbAdapter'

function migrate(dbAdapter: DatabaseAdapter) {
  return async function(c: Context) {
    const migrateService = await import('../service/migrateService')
    const count = await migrateService.migrate(dbAdapter)
    return c.json({ success: true, count })
  }
}

function status(dbAdapter: DatabaseAdapter) {
  return async function(c: Context) {
    const migrateService = await import('../service/migrateService')
    const version = await migrateService.getCurrentVersion(dbAdapter)
    return c.json({ currentVersion: version })
  }
}

export { migrate, status }
