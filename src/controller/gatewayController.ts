import { Context } from "hono";
import sender from "../service/senderService";
import { SgModel } from "../model/sgModel";
import { SgUser } from "../model/sgUser";
import { SgVendor } from "../model/sgVendor";
import { ApiFormat } from "../constants";

async function chatCompletions(c: Context) {
    const user = c.get("user") as SgUser;
    const modelConfig = c.get("modelConfig") as SgModel;
    const vendor = c.get("vendor") as SgVendor;
    const body = c.get("requestBody") as string;
    
    return sender.sendRequest(c, user, modelConfig, vendor, ApiFormat.OPENAI, body);
}

async function anthropicMessages(c: Context) {
    const user = c.get("user") as SgUser;
    const modelConfig = c.get("modelConfig") as SgModel;
    const vendor = c.get("vendor") as SgVendor;
    const body = c.get("requestBody") as string;
    
    return sender.sendRequest(c, user, modelConfig, vendor, ApiFormat.ANTHROPIC, body);
}

async function responsesApi(c: Context) {
    const user = c.get("user") as SgUser;
    const modelConfig = c.get("modelConfig") as SgModel;
    const vendor = c.get("vendor") as SgVendor;
    const body = c.get("requestBody") as string;
    
    return sender.sendRequest(c, user, modelConfig, vendor, ApiFormat.RESPONSES, body);
}

export default {
    chatCompletions,
    anthropicMessages,
    responsesApi,
};
