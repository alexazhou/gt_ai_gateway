import { Context } from "hono";
import modelService from "../service/modelService";
import userService from "../service/userService";
import { ModelConfig } from "../model/modelConfig";
import sender from "../service/senderService";
import {User} from "../model/user";


async function chatCompletions(c: Context) {

    let body: string = await c.req.text();
    console.log("body:", body);

    //获取用户
    const authHeader = c.req.header('Authorization');

    if (!authHeader) {
        return c.json({ error: 'Authorization header is missing' }, 401);
    }

    // 检查 Authorization header 是否以 "Bearer " 开头
    if (!authHeader.startsWith('Bearer ')) {
        return c.json({ error: 'Invalid token format' }, 401);
    }

    // 提取 token
    const token = authHeader.split(' ')[1];

    let user:User|null = await userService.getUser(token!);
    console.log("user:", user);

    if(user == null){
        return c.json({ error: 'Invalid token (user not found)' }, 401);
    }
    
    //解析请求
    let bodyDict = JSON.parse(body);
    console.log("bodyDict:", bodyDict, typeof bodyDict);

    //获取后端模型配置
    let modelName = bodyDict.model;
    let modelConfig:ModelConfig | null = await modelService.getModel(modelName);
    console.log("modelConfig:", modelConfig);

    return sender.sendRequest(c, user!, modelConfig!);
}

export {
    chatCompletions
}