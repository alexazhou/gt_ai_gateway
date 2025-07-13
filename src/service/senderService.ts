import {Context} from "hono";
import {SgModel} from "../model/sgModel";
import {StatusCode} from "hono/dist/types/utils/http-status";
import {CustomPromise} from "../util/enhanced";
import {streamSSE, SSEStreamingApi} from 'hono/streaming'
import {EventStreamContentType, fetchEventSource} from "@fortaine/fetch-event-source";
import {SgUser} from "../model/sgUser";
import {SgVendor} from "../model/sgVendor";
import recordService from "./recordService";


async function sendRequest (c:Context, user:SgUser, modelConfig:SgModel, vendor:SgVendor):Promise<Response>{

    let body: string = await c.req.text();
    const record = await recordService.create(user.id, modelConfig.id, body);
    const recordId = record.id;

    console.log("sendRequest: modelConfig={}", modelConfig);

    let streamResponse: boolean = true;
    let upstreamStatusCode: StatusCode | null = null;
    let responseText: string | null = null;

    let getResponseHeaderPromise: CustomPromise<void> = new CustomPromise();

    console.log("body:", body);

    let requestOptions = {
        method: 'POST',
        headers: {
            'accept': "*/*",
            'Content-Type': 'application/json',
            "Authorization": vendor!.token!,
        },
        body: body,
    }
    console.log("requestOptions:", requestOptions);

    let upstreamReqPromise: Promise<void> | null = null;
    let streamOutputPipe: SSEStreamingApi | null = null;

    console.log("do fetch upstream");
    upstreamReqPromise = fetchEventSource(vendor!.url!, {
        ...requestOptions,
        async onopen(response:Response) {
            upstreamStatusCode = response.status as StatusCode;

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
                    responseText = await response.clone().text();
                    console.log("statusCode:",response.status);
                    console.log("responseText:",responseText);
                }

                console.log("fallback to json response");
                getResponseHeaderPromise.resolve(null);

            } else {
                console.log("onOpen, but content-type not except:", response);
                streamResponse = false;
                responseText = await response.clone().text();
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

    console.log("before await getResponseHeaderPromise", getResponseHeaderPromise);
    await getResponseHeaderPromise;
    console.log("after getResponseHeaderPromise finished", getResponseHeaderPromise);
    console.log("streamResponse:", streamResponse);

    let streamSSEResponse = streamSSE(c, async (stream: SSEStreamingApi) => {
        streamOutputPipe = stream;
        console.log("before await upstreamReqPromise",upstreamReqPromise);
        await upstreamReqPromise;
        console.log("after upstreamReqPromise finished", upstreamReqPromise);
    });

    if(streamResponse === true){
        return streamSSEResponse;
    }else{
        recordService.update(recordId, {
            response_data:responseText
        })

        c.status(upstreamStatusCode!);
        c.res.headers.set("Content-Type","application/json");
        return c.text(responseText!)
    }
}

export default {
    sendRequest,
}