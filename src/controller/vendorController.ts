import { Context } from 'hono'
import { SgVendor } from '../model/sgVendor'

async function listVendors(c: Context) {
  const users = await SgVendor.query().get()
  return c.json(users)
}

async function getVendor(c: Context) {
  const { id } = c.req.param()

  const vendor = await SgVendor.query().findOrFail(id)
  return c.json(vendor)
}

async function createVendor(c: Context) {
  const body = await c.req.json()
  const { type, name, token, url } = body

  const instance = await SgVendor.query().create({
    type,
    name,
    token,
    url,
  })

  return c.json(instance)
}

export { listVendors, getVendor, createVendor }
