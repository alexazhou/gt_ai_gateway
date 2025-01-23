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
    let authToken:string|undefined = c.req.header('Authorization');
    let user:User|null = await userService.getUser(authToken!);
    console.log("user:", user);

    //获取请求模型
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