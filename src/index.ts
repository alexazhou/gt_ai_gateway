import {Context, Hono, Next} from 'hono'
import ClientD1 from 'knex-cloudflare-d1';
import { ModelNotFoundError, sutando } from 'sutando';

import {SgUser} from "./model/sgUser";
import {SgModel} from "./model/sgModel";
import {SgVendor} from "./model/sgVendor";
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

  const instance = await SgModel.query().create({
    name,
    vendor,
    url,
  });

  return c.json(instance);
});

app.get('/model/list.json', async (c) => {
  const modelConfigs = await SgModel.query().get();
  return c.json(modelConfigs);
});

app.get('/user/list.json', async (c) => {
  const users = await SgUser.query().get();
  return c.json(users);
});

app.post('/user/create.json', async (c) => {
  const body = await c.req.json();
  const { name } = body;

  const token:String = crypto.randomUUID();

  const instance = await SgUser.query().create({
    name,
    token,
  });

  return c.json(instance);
});

app.get('/vendor/list.json', async (c) => {
  const users = await SgVendor.query().get();
  return c.json(users);
});

app.post('/vendor/create.json', async (c) => {
  const body = await c.req.json();
  const { type,name,token,url } = body;

  const instance = await SgVendor.query().create({
    type,
    name,
    token,
    url,
  });

  return c.json(instance);
});




app.post('/v1/chat/completions', chatCompletions);

export default app
