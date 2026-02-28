import { Hono } from 'hono'
import { sutando } from 'sutando'
import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { serve } from '@hono/node-server'

import {SgUser} from "./model/sgUser";
import {SgModel} from "./model/sgModel";
import {SgVendor} from "./model/sgVendor";
import {SgRecord} from "./model/sgRecord";
import recordService from "./service/recordService";
import { chatCompletions } from './web/aiApiEntry'

const DB_PATH = join(process.cwd(), 'local.db')

// 初始化数据库
function initDatabase() {
  const db = new Database(DB_PATH)

  // 创建表结构
  db.exec(`
    CREATE TABLE IF NOT EXISTS user (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      token TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS vendor (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      token TEXT NOT NULL,
      url TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS model (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      vendor_id INTEGER DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS record (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      model_id INTEGER,
      request_data TEXT,
      response_data TEXT,
      status TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS token_index ON user (token);
  `)

  db.close()
}

// 确保数据库初始化
initDatabase()

// 配置 Sutando 连接
sutando.addConnection({
  client: 'better-sqlite3',
  connection: {
    filename: DB_PATH,
  },
  useNullAsDefault: true,
})

const app = new Hono()

app.get('/', (c) => {
  return c.text('Hello, welcome to serverless ai gateway (local mode)!')
})

app.get('/initDatabase.json', async (c) => {
  return c.json({ message: 'Database initialized' })
})

app.post('/model/create.json', async (c) => {
  const body = await c.req.json()
  const { name, vendor_id } = body

  const instance = await SgModel.query().create({
    name,
    vendor_id,
  })

  return c.json(instance)
})

app.get('/model/list.json', async (c) => {
  const modelConfigs = await SgModel.query().get()
  return c.json(modelConfigs)
})

app.get('/user/list.json', async (c) => {
  const users = await SgUser.query().get()
  return c.json(users)
})

app.get(`/user/:id`, async (c) => {
  const { id } = c.req.param()

  const user = await SgUser.query().findOrFail(id)
  console.log("user", user)
  return c.json(user)
})

app.post('/user/create.json', async (c) => {
  const body = await c.req.json()
  let { name, token } = body

  if(token == null){
    token = crypto.randomUUID()
  }

  const instance = await SgUser.query().create({
    name,
    token,
  })

  return c.json(instance)
})

app.get('/vendor/list.json', async (c) => {
  const users = await SgVendor.query().get()
  return c.json(users)
})

app.get(`/vendor/:id`, async (c) => {
  const { id } = c.req.param()

  const vendor = await SgVendor.query().findOrFail(id)
  return c.json(vendor)
})

app.post('/vendor/create.json', async (c) => {
  const { type, name, token, url } = await c.req.json()

  const instance = await SgVendor.query().create({
    type,
    name,
    token,
    url,
  })

  return c.json(instance)
})

app.get('/record/list.json', async (c) => {
  const records = await SgRecord.query().get()
  return c.json(records)
})

app.get('/record/latest.json', async (c) => {
  const { limit } = c.req.query()
  const limitNumber = limit ? parseInt(limit, 10) : 10
  const records = await recordService.latest(limitNumber)
  return c.json(records)
})

app.get('/record/:id', async (c) => {
  const { id } = c.req.param()
  console.log("id", id)
  const record = await SgRecord.query().findOrFail(id)
  return c.json(record)
})

app.post('/v1/chat/completions', chatCompletions)

// 启动服务器
const port = parseInt(process.env.PORT || '3000', 10)
console.log(`Starting server on http://localhost:${port}`)

serve({
  fetch: app.fetch,
  port,
})
