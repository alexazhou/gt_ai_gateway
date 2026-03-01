import { Context } from 'hono'

function welcome(mode: 'cloud' | 'local') {
  return function(c: Context) {
    const message = mode === 'cloud'
      ? 'Hello, welcome to serverless ai gateway!'
      : 'Hello, welcome to serverless ai gateway (local mode)!'
    return c.text(message)
  }
}

function initDatabase(mode: 'cloud' | 'local') {
  return async function(c: Context) {
    if (mode === 'cloud') {
      return c.text('init database')
    }
    return c.json({ message: 'Database initialized' })
  }
}

export { welcome, initDatabase }
