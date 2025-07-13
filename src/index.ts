import {Context, Hono, Next} from 'hono'
import ClientD1 from 'knex-cloudflare-d1';
import { ModelNotFoundError, sutando } from 'sutando';

import {SgUser} from "./model/sgUser";
import {SgModel} from "./model/sgModel";
import {SgVendor} from "./model/sgVendor";
import {SgRecord} from "./model/sgRecord";
import recordService from "./service/recordService";
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

  console.log("prepareDBConnection");
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
  const { name, vendor_id } = body;

  const instance = await SgModel.query().create({
    name,
    vendor_id,
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

app.get(`/user/:id`, async (c) => {
  const { id } = c.req.param();

  const user = await SgUser.query().findOrFail(id);
  console.log("user", user);
  return c.json(user);
});

app.post('/user/create.json', async (c) => {
  const body = await c.req.json();
  let { name,token } = body;

  if(token == null){
    token = crypto.randomUUID();
  }

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

app.get(`/vendor/:id`, async (c) => {
  const { id } = c.req.param();

  const vendor = await SgVendor.query().findOrFail(id);
  return c.json(vendor);
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

app.get('/record/list.json', async (c) => {
  const records = await SgRecord.query().get();
  return c.json(records);
});

app.get('/record/latest.json', async (c) => {
    const { limit } = c.req.query();
    const limitNumber = limit ? parseInt(limit, 10) : 10;
    const records = await recordService.latest(limitNumber);
    return c.json(records);
});

app.get('/record/:id', async (c) => {
  const { id } = c.req.param();
  console.log("id", id);
  const record = await SgRecord.query().findOrFail(id);
  return c.json(record);
});




app.post('/v1/chat/completions', chatCompletions);

export default app
