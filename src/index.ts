import {Context, Hono, Next} from 'hono'
import { chatCompletions } from './web/aiApiEntry'


declare module 'hono' {
  interface ContextVariableMap {
  }
}

export interface Env {
  DB: D1Database;
}

const app = new Hono();

async function prepareDBConnection(c:Context, next:Next){
  await next();
}

app.use(prepareDBConnection);

app.get('/', (c) => {
  return c.text('Hello, welcome to serverless ai gateway!')
})

app.get('/testORM.json', async (c) => {
})

app.post('/v1/chat/completions', chatCompletions);

export default app
