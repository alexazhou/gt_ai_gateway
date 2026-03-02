import { Context } from 'hono'
import { SgUser } from '../model/sgUser'

async function listUsers(c: Context) {
  const users = await SgUser.query().get()
  return c.json(users)
}

async function getUser(c: Context) {
  const { id } = c.req.param()

  const user = await SgUser.query().find(id)

  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  return c.json(user)
}

async function createUser(c: Context) {
  const body = await c.req.json()
  let { name, token } = body

  if (token === null || token === undefined || token === '') {
    token = crypto.randomUUID()
  }

  const instance = await SgUser.query().create({
    name,
    token,
  })

  return c.json(instance)
}

export default {
    listUsers,
    getUser,
    createUser
}
