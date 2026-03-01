import { Hono, MiddlewareHandler } from 'hono'
import { DatabaseAdapter } from './service/dbAdapter'
import { chatCompletions } from './controller/gatewayController'
import * as ModelController from './controller/modelController'
import * as UserController from './controller/userController'
import * as VendorController from './controller/vendorController'
import * as RecordController from './controller/recordController'
import * as MigrateController from './controller/migrateController'
import * as SystemController from './controller/systemController'

declare module 'hono' {
  interface ContextVariableMap {
  }
}

interface Env {
  DB: D1Database;
}

interface RoutesOptions {
  dbAdapter: DatabaseAdapter
  mode: 'cloud' | 'local'
  middlewares?: MiddlewareHandler[]
}

function createApp(options: RoutesOptions) {
  const app = new Hono()

  if (options.middlewares) {
    options.middlewares.forEach(m => app.use(m))
  }

  return setupRoutes(app, options)
}

function setupRoutes(app: Hono, options: RoutesOptions) {
  const { dbAdapter, mode } = options

  // System
  app.get('/', SystemController.welcome(mode))
  app.get('/initDatabase.json', SystemController.initDatabase(mode))

  // Migration
  app.post('/migrate', MigrateController.migrate(dbAdapter))
  app.get('/migrate/status', MigrateController.status(dbAdapter))

  // Model
  app.post('/model/create.json', ModelController.createModel)
  app.get('/model/list.json', ModelController.listModels)

  // User
  app.get('/user/list.json', UserController.listUsers)
  app.get('/user/:id', UserController.getUser)
  app.post('/user/create.json', UserController.createUser)

  // Vendor
  app.get('/vendor/list.json', VendorController.listVendors)
  app.get('/vendor/:id', VendorController.getVendor)
  app.post('/vendor/create.json', VendorController.createVendor)

  // Record
  app.get('/record/list.json', RecordController.listRecords)
  app.get('/record/latest.json', RecordController.latestRecords)
  app.get('/record/:id', RecordController.getRecord)

  // AI
  app.post('/v1/chat/completions', chatCompletions)

  return app
}

export { Env, RoutesOptions, createApp, setupRoutes }
