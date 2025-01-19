import {Context} from "hono";

function chatCompletions (c: Context){
    return c.text('openai chatCompletions!')
}

export {
    chatCompletions
}