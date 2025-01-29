import {Context, Hono, Next} from 'hono'
import ClientD1 from 'knex-cloudflare-d1';
import { ModelNotFoundError, sutando } from 'sutando';

import {User} from "./model/user";
import {ModelConfig} from "./model/modelConfig";
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

  sutando.addConnection({
    client: ClientD1,
    connection: {
      database: c.env.DB
    },
    useNullAsDefault: true,
  });

  await next();
}

app.use(prepareDBConnection);

app.get('/', (c) => {
  return c.text('Hello, welcome to serverless ai gateway!')
});

app.get('/initDatabase.json', async (c) => {
  return c.text('init database');

});

app.post('/model/create.json', async (c) => {
  const body = await c.req.json();
  const { name, vendor, url } = body;

  const post = await ModelConfig.query().create({
    name,
    vendor,
    url,
  });

  return c.json(post);
});


app.get('/user/list.json', async (c) => {
  const users = await User.query().get();
  return c.json(users);
});

app.get('/model/list.json', async (c) => {
  const modelConfigs = await ModelConfig.query().get();
  return c.json(modelConfigs);
});

app.post('/v1/chat/completions', chatCompletions);

export default app
