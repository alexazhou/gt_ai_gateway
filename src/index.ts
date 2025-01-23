import { Hono } from 'hono'
import { chatCompletions } from './web/aiApiEntry'

const app = new Hono()


app.get('/', (c) => {
  return c.text('Hello, welcome to serverless ai gateway!')
})

app.post('/v1/chat/completions', chatCompletions);

export default app
