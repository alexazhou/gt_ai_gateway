import { Hono } from 'hono'
import { chatCompletions } from './web/openai'

const app = new Hono()


app.get('/', (c) => {
  return c.text('Hello Hono!')
})

app.get('/v1/chat/completions', chatCompletions);

export default app
