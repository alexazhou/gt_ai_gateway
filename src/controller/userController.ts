import { Context } from 'hono'
import { SgUser } from '../model/sgUser'

async function listUsers(c: Context) {
  const users = await SgUser.query().get()
  return c.json(users)
}

async function getUser(c: Context) {
  const { id } = c.req.param()

  const user = await SgUser.query().findOrFail(id)
  console.log("user", user)
  return c.json(user)
}

async function createUser(c: Context) {
  const body = await c.req.json()
  let { name, token } = body

  if (token == null) {
    token = crypto.randomUUID()
  }

  const instance = await SgUser.query().create({
    name,
    token,
  })

  return c.json(instance)
}

export { listUsers, getUser, createUser }
