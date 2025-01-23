import {Context} from "hono";
import {ModelConfig} from "../model/modelConfig";
import {StatusCode} from "hono/dist/types/utils/http-status";
import {CustomPromise} from "../util/enhanced";
import { streamSSE, SSEStreamingApi} from 'hono/streaming'
import {EventStreamContentType, fetchEventSource} from "@fortaine/fetch-event-source";
import {User} from "../model/user";


async function sendRequest (c:Context, user:User, modelConfig:ModelConfig):Promise<Response>{

    console.log("sendRequest: modelConfig={}", modelConfig);

    let streamResponse: boolean = true;

    let failedStatusCode: StatusCode | null = null;
    let failedMessage: string | null = null;

    let getResponseHeaderPromise: CustomPromise<void> = new CustomPromise();

    let body: string = await c.req.text();
    console.log("body:", body);

    let requestOptions = {
        method: 'POST',
        headers: {
            'accept': "*/*",
            'Content-Type': 'application/json',
            "Authorization": user.token!,
        },
        body: body,
    }
    console.log("requestOptions:", requestOptions);

    let upstreamReqPromise: Promise<void> | null = null;
    let streamOutputPipe: SSEStreamingApi | null = null;

    let streamSSEResponse = streamSSE(c, async (stream: SSEStreamingApi) => {
        streamOutputPipe = stream;
        console.log("set outputStream",upstreamReqPromise);
        await getResponseHeaderPromise;
        await upstreamReqPromise;
        console.log("upstreamReqPromise finished");
    });

    console.log("do fetch upstream");

    //upstreamReqPromise =
    upstreamReqPromise = fetchEventSource(modelConfig!.url!, {
        ...requestOptions,
        async onopen(response:Response) {
            if (response.ok && response.headers.get('content-type')?.startsWith(EventStreamContentType)) {
                console.log("onOpen:", response);

                getResponseHeaderPromise.resolve(null);

                return; // everything's good

            } else if (response.status >= 400 && response.status < 500 && response.status !== 429) {
                // client-side errors are usually non-retriable:
                console.log("onOpen, but has error:", response);

                streamResponse = false;

                const contentType = response.headers.get("content-type");
                console.log("upstream response content type: ", contentType);

                if (contentType?.startsWith("text/plain") || contentType?.startsWith("application/json")) {
                    let responseText:string = await response.clone().text();
                    console.log("statusCode:",response.status);
                    console.log("responseText:",responseText);

                    failedStatusCode = response.status as StatusCode;
                    failedMessage = responseText;

                }

                console.log("fallback to json response");
                getResponseHeaderPromise.resolve(null);

            } else {
                console.log("onOpen, but content-type not except:", response);
                let responseText:string = await response.clone().text();
                console.log("statusCode:",response.status);
                console.log("responseText:",responseText);

                getResponseHeaderPromise.resolve(null);
            }
        },
        async onmessage(msg) {
            // if the server emits an error message, throw an exception
            // so it gets handled by the onerror callback below:
            console.log("onMessage:", msg);
            await streamOutputPipe!.writeSSE(msg);
        },
        onclose() {
            // if the server closes the connection unexpectedly, retry:

            console.log("onClose");

            getResponseHeaderPromise.resolve(null);
        },
        onerror(err:Response) {
            console.log("onerror:", err);

            getResponseHeaderPromise.resolve(null);
        }
    });

    console.log("before getResponseHeaderPromise");
    await getResponseHeaderPromise;
    console.log("after getResponseHeaderPromise");
    console.log("streamResponse:", streamResponse);

    if(streamResponse === true){
        return streamSSEResponse;
    }else{
        c.status(failedStatusCode!);
        c.res.headers.set("Content-Type","application/json");
        return c.text(failedMessage!)
    }
}

export default {
    sendRequest,
}