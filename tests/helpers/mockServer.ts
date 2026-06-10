import { createServer, IncomingMessage, ServerResponse } from "http";
import { createWriteStream, existsSync, mkdirSync } from "fs";
import { join } from "path";

const DEFAULT_MOCK_PORT = 9999;

let server: ReturnType<typeof createServer> | null = null;
let isRunning = false;

/**
 * Store received headers for testing
 */
let receivedHeaders: Record<string, string> = {};

/**
 * Mock server log stream
 */
let mockLogStream: ReturnType<typeof createWriteStream> | null = null;

/**
 * Initialize mock logger with log directory and file name
 */
function initMockLogger(logDir: string, logFileName: string): void {
    if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
    }
    const logPath = join(logDir, logFileName);
    // Use 'w' mode to overwrite old logs on each run
    mockLogStream = createWriteStream(logPath, { flags: 'w' });
}

/**
 * Log message to mock server log file
 */
function mockLog(message: string): void {
    if (mockLogStream) {
        mockLogStream.write(`[${new Date().toISOString()}] ${message}\n`);
    }
}

function formatListenError(port: number, error: NodeJS.ErrnoException): string {
    switch (error.code) {
        case "EADDRINUSE":
            return `Port ${port} is already in use. Please stop any existing mock server or process using this port.`;
        case "EACCES":
        case "EPERM":
            return `Port ${port} cannot be opened in the current environment (${error.code}). Check local permissions or sandbox restrictions.`;
        default:
            return `Failed to start mock server on port ${port}: ${error.message}`;
    }
}

/**
 * Mock AI Server
 * Simulates OpenAI and Anthropic API responses including SSE streaming
 */

/**
 * Start the mock AI server
 */
async function startMockServer(port: number = DEFAULT_MOCK_PORT): Promise<any> {
    if (isRunning) {
        console.log(`Mock server already running on port ${port}`);
        mockLog(`Mock server already running on port ${port}`);
        return null;
    }

    return new Promise((resolve, reject) => {
        server = createServer((req: IncomingMessage, res: ServerResponse) => {
            handleRequest(req, res);
        });

        server.on("error", (err) => {
            const nodeError = err as NodeJS.ErrnoException;
            const errorMsg = formatListenError(port, nodeError);
            mockLog(`Error: ${errorMsg}`);
            reject(new Error(errorMsg));
        });

        server.listen(port, () => {
            isRunning = true;
            console.log(`Mock AI server listening on port ${port}`);
            mockLog(`Mock AI server listening on port ${port}`);
            resolve(server);
        });
    });
}

/**
 * Stop the mock AI server
 */
async function stopMockServer(serverInstance: any): Promise<void> {
    if (serverInstance) {
        return new Promise((resolve) => {
            serverInstance.close(() => {
                isRunning = false;
                console.log("Mock AI server stopped");
                // Close mock log stream
                if (mockLogStream) {
                    mockLogStream.end();
                    mockLogStream = null;
                }
                resolve();
            });
        });
    }
}

/**
 * Check if mock server is running
 */
function isMockServerRunning(): boolean {
    return isRunning;
}

/**
 * Handle incoming requests
 */
function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url || "";

    // Store received headers for testing
    receivedHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) {
        if (value) {
            receivedHeaders[key] = value;
        }
    }
    const headersMsg = `[MOCK] Received headers: ${JSON.stringify(receivedHeaders)}`;
    console.log(headersMsg);
    mockLog(headersMsg);

    // Add CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS",
    );
    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, x-api-key",
    );

    // Handle OPTIONS request for CORS
    if (req.method === "OPTIONS") {
        res.writeHead(200);
        res.end();
        return;
    }

    // Log the request
    const requestMsg = `[MOCK] ${req.method} ${url}`;
    console.log(requestMsg);
    mockLog(requestMsg);

    // Handle different endpoints (more specific paths must come before generic ones)
    if (url.includes("/chat/completions/incomplete")) {
        handleOpenAIStreamIncomplete(req, res);
    } else if (url.includes("/chat/completions/disconnect")) {
        handleOpenAIStreamDisconnect(req, res);
    } else if (url.includes("/chat/completions")) {
        handleOpenAIChat(req, res);
    } else if (url.includes("/responses/incomplete")) {
        handleResponsesStreamIncomplete(req, res);
    } else if (url.includes("/responses")) {
        handleOpenAIResponses(req, res);
    } else if (url.includes("/messages/incomplete")) {
        handleAnthropicStreamIncomplete(req, res);
    } else if (url.includes("/messages")) {
        handleAnthropicMessages(req, res);
    } else if (req.method === "GET" && url.includes("/models")) {
        handleModelsList(req, res);
    } else {
        handleNotFound(res);
    }
}

/**
 * Handle OpenAI chat completions
 */
function handleOpenAIChat(req: IncomingMessage, res: ServerResponse): void {
    let body = "";

    req.on("data", (chunk) => {
        body += chunk.toString();
    });

    req.on("end", () => {
        try {
            const data = body ? JSON.parse(body) : {};
            const isStream = data.stream === true;
            const hasTools = Array.isArray(data.tools) && data.tools.length > 0;

            if (isStream) {
                if (hasTools) {
                    handleOpenAIToolCallStreamResponse(res, data);
                } else {
                    handleOpenAIStreamResponse(res, data);
                }
            } else {
                handleOpenAINonStreamResponse(res, data);
            }
        } catch (e) {
            const errorMsg = `Error parsing request body: ${e}`;
            console.error(errorMsg);
            mockLog(errorMsg);
            handleBadRequest(res, "Invalid request body");
        }
    });
}

/**
 * Handle OpenAI non-streaming response
 */
function handleOpenAINonStreamResponse(res: ServerResponse, data: any): void {
    const response = {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: data.model || "gpt-3.5-turbo",
        choices: [
            {
                index: 0,
                message: {
                    role: "assistant",
                    content:
                        "Hello! I am a mock AI assistant. How can I help you today?",
                },
                finish_reason: "stop",
            },
        ],
        usage: {
            prompt_tokens: 10,
            completion_tokens: 15,
            total_tokens: 25,
        },
        // Include received headers for testing
        _received_headers: receivedHeaders,
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
}

/**
 * Handle OpenAI streaming response
 */
function handleOpenAIStreamResponse(res: ServerResponse, data: any): void {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });

    const chunks = [
        { role: "assistant", content: "Hello!" },
        { content: " I am" },
        { content: " a mock" },
        { content: " AI assistant." },
        { content: " How can I help you?" },
    ];

    let i = 0;
    const interval = setInterval(() => {
        if (i >= chunks.length) {
            // Send final chunk with usage information
            const finalChunk = {
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: data.model || "gpt-3.5-turbo",
                choices: [
                    {
                        index: 0,
                        delta: {},
                        finish_reason: "stop",
                    },
                ],
                usage: {
                    prompt_tokens: 8,
                    completion_tokens: 12,
                    total_tokens: 20,
                },
            };
            res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
            clearInterval(interval);
            return;
        }

        const chunk = {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: data.model || "gpt-3.5-turbo",
            choices: [
                {
                    index: 0,
                    delta: chunks[i],
                    finish_reason: null,
                },
            ],
        };

        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        i++;
    }, 100);
}

function handleOpenAIToolCallStreamResponse(res: ServerResponse, data: any): void {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });

    const toolChunks = [
        {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: data.model || "gpt-4o-mini",
            choices: [
                {
                    index: 0,
                    delta: { role: "assistant" },
                    finish_reason: null,
                },
            ],
        },
        {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: data.model || "gpt-4o-mini",
            choices: [
                {
                    index: 0,
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                id: "call_weather_001",
                                type: "function",
                                function: {
                                    name: "get_weather",
                                    arguments: "",
                                },
                            },
                        ],
                    },
                    finish_reason: null,
                },
            ],
        },
        {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: data.model || "gpt-4o-mini",
            choices: [
                {
                    index: 0,
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                function: {
                                    arguments: "{\"city\":\"San",
                                },
                            },
                        ],
                    },
                    finish_reason: null,
                },
            ],
        },
        {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: data.model || "gpt-4o-mini",
            choices: [
                {
                    index: 0,
                    delta: {
                        tool_calls: [
                            {
                                index: 0,
                                function: {
                                    arguments: " Francisco\",\"unit\":\"celsius\"}",
                                },
                            },
                        ],
                    },
                    finish_reason: null,
                },
            ],
        },
    ];

    let i = 0;
    const interval = setInterval(() => {
        if (i >= toolChunks.length) {
            const finalChunk = {
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: data.model || "gpt-4o-mini",
                choices: [
                    {
                        index: 0,
                        delta: {},
                        finish_reason: "tool_calls",
                    },
                ],
                usage: {
                    prompt_tokens: 18,
                    completion_tokens: 9,
                    total_tokens: 27,
                },
            };
            res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
            clearInterval(interval);
            return;
        }

        res.write(`data: ${JSON.stringify(toolChunks[i])}\n\n`);
        i++;
    }, 100);
}

/**
 * Handle OpenAI Responses API
 */
function handleOpenAIResponses(req: IncomingMessage, res: ServerResponse): void {
    let body = "";

    req.on("data", (chunk) => {
        body += chunk.toString();
    });

    req.on("end", () => {
        try {
            const data = body ? JSON.parse(body) : {};
            const isStream = data.stream === true;

            if (isStream) {
                handleResponsesStreamResponse(res, data);
            } else {
                handleResponsesNonStreamResponse(res, data);
            }
        } catch (e) {
            handleBadRequest(res, "Invalid request body");
        }
    });
}

function handleResponsesNonStreamResponse(res: ServerResponse, data: any): void {
    const msgId = `msg_mock_${Date.now()}`;
    const respId = `resp_mock_${Date.now()}`;
    const now = Math.floor(Date.now() / 1000);

    const response = {
        id: respId,
        object: "response",
        created_at: now,
        model: data.model || "gpt-4o",
        status: "completed",
        output: [
            {
                id: msgId,
                type: "message",
                role: "assistant",
                status: "completed",
                content: [
                    {
                        type: "output_text",
                        text: "Hello! I am a mock AI assistant. How can I help you today?",
                        annotations: [],
                    },
                ],
            },
        ],
        usage: {
            input_tokens: 10,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 15,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 25,
        },
        error: null,
        incomplete_details: null,
        instructions: null,
        reasoning: { effort: "none", summary: null },
        temperature: 1.0,
        tool_choice: "auto",
        tools: [],
        completed_at: now,
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
}

function handleResponsesStreamResponse(res: ServerResponse, data: any): void {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });

    const msgId = `msg_mock_${Date.now()}`;
    const respId = `resp_mock_${Date.now()}`;
    const now = Math.floor(Date.now() / 1000);
    const model = data.model || "gpt-4o";

    const baseResponse = {
        id: respId,
        object: "response",
        created_at: now,
        model,
        status: "in_progress",
        output: [],
        error: null,
        incomplete_details: null,
        instructions: null,
        reasoning: { effort: "none", summary: null },
        temperature: 1.0,
        tool_choice: "auto",
        tools: [],
        usage: null,
        completed_at: null,
    };

    const textChunks = ["Hello", "!", " I am", " a mock", " AI assistant."];

    const events: Array<{ type: string; data: object }> = [
        {
            type: "response.created",
            data: { type: "response.created", sequence_number: 0, response: { ...baseResponse } },
        },
        {
            type: "response.in_progress",
            data: { type: "response.in_progress", sequence_number: 1, response: { ...baseResponse } },
        },
        {
            type: "response.output_item.added",
            data: {
                type: "response.output_item.added",
                sequence_number: 2,
                output_index: 0,
                item: { id: msgId, type: "message", role: "assistant", status: "in_progress", content: [] },
            },
        },
        {
            type: "response.content_part.added",
            data: {
                type: "response.content_part.added",
                sequence_number: 3,
                output_index: 0,
                content_index: 0,
                item_id: msgId,
                part: { type: "output_text", text: "", annotations: [] },
            },
        },
        ...textChunks.map((delta, i) => ({
            type: "response.output_text.delta",
            data: {
                type: "response.output_text.delta",
                sequence_number: 4 + i,
                output_index: 0,
                content_index: 0,
                item_id: msgId,
                delta,
            },
        })),
        {
            type: "response.output_text.done",
            data: {
                type: "response.output_text.done",
                sequence_number: 4 + textChunks.length,
                output_index: 0,
                content_index: 0,
                item_id: msgId,
                text: textChunks.join(""),
            },
        },
        {
            type: "response.content_part.done",
            data: {
                type: "response.content_part.done",
                sequence_number: 5 + textChunks.length,
                output_index: 0,
                content_index: 0,
                item_id: msgId,
                part: { type: "output_text", text: textChunks.join(""), annotations: [] },
            },
        },
        {
            type: "response.output_item.done",
            data: {
                type: "response.output_item.done",
                sequence_number: 6 + textChunks.length,
                output_index: 0,
                item: {
                    id: msgId,
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: textChunks.join(""), annotations: [] }],
                },
            },
        },
        {
            type: "response.completed",
            data: {
                type: "response.completed",
                sequence_number: 7 + textChunks.length,
                response: {
                    ...baseResponse,
                    status: "completed",
                    output: [
                        {
                            id: msgId,
                            type: "message",
                            role: "assistant",
                            status: "completed",
                            content: [{ type: "output_text", text: textChunks.join(""), annotations: [] }],
                        },
                    ],
                    usage: {
                        input_tokens: 10,
                        input_tokens_details: { cached_tokens: 0 },
                        output_tokens: 15,
                        output_tokens_details: { reasoning_tokens: 0 },
                        total_tokens: 25,
                    },
                    completed_at: now,
                },
            },
        },
    ];

    let i = 0;
    const interval = setInterval(() => {
        if (i >= events.length) {
            res.end();
            clearInterval(interval);
            return;
        }
        res.write(`data: ${JSON.stringify(events[i].data)}\n\n`);
        i++;
    }, 100);
}

/**
 * Handle Anthropic messages
 */
function handleAnthropicMessages(
    req: IncomingMessage,
    res: ServerResponse,
): void {
    let body = "";

    req.on("data", (chunk) => {
        body += chunk.toString();
    });

    req.on("end", () => {
        try {
            const data = body ? JSON.parse(body) : {};
            const isStream = data.stream === true;
            const hasTools = Array.isArray(data.tools) && data.tools.length > 0;

            if (isStream) {
                if (hasTools) {
                    handleAnthropicToolUseStreamResponse(res, data);
                } else {
                    handleAnthropicStreamResponse(res, data);
                }
            } else {
                handleAnthropicNonStreamResponse(res, data);
            }
        } catch (e) {
            const errorMsg = `Error parsing request body: ${e}`;
            console.error(errorMsg);
            mockLog(errorMsg);
            handleBadRequest(res, "Invalid request body");
        }
    });
}

/**
 * Handle Anthropic non-streaming response
 */
function handleAnthropicNonStreamResponse(
    res: ServerResponse,
    data: any,
): void {
    const response = {
        id: `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        content: [
            {
                type: "text",
                text: "Hello! I am a mock Claude assistant. How can I help you today?",
            },
        ],
        model: data.model || "claude-3-haiku-20240307",
        stop_reason: "end_turn",
        usage: {
            input_tokens: 10,
            output_tokens: 15,
        },
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
}

/**
 * Handle Anthropic streaming response
 */
function handleAnthropicStreamResponse(res: ServerResponse, data: any): void {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });

    const chunks = [
        { type: "text_delta", text: "Hello!" },
        { type: "text_delta", text: " I am" },
        { type: "text_delta", text: " a mock" },
        { type: "text_delta", text: " Claude assistant." },
        {
            type: "text_delta",
            text: " How can I help you?",
        },
    ];

    // Send message_start event
    const startEvent = {
        type: "message_start",
        message: {
            id: `msg_${Date.now()}`,
            type: "message",
            role: "assistant",
            content: [],
            model: data.model || "claude-3-haiku-20240307",
            stop_reason: null,
            usage: { input_tokens: 8, output_tokens: 0 },
        },
    };
    res.write(`event: message_start\ndata: ${JSON.stringify(startEvent)}\n\n`);

    let i = 0;
    const interval = setInterval(() => {
        if (i >= chunks.length) {
            // Send message_delta event with final usage
            const deltaEvent = {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: 12 },
            };
            res.write(
                `event: message_delta\ndata: ${JSON.stringify(deltaEvent)}\n\n`,
            );

            // Send message_stop event
            const stopEvent = {
                type: "message_stop",
            };
            res.write(
                `event: message_stop\ndata: ${JSON.stringify(stopEvent)}\n\n`,
            );
            res.end();
            clearInterval(interval);
            return;
        }

        const chunkEvent = {
            type: "content_block_delta",
            index: 0,
            delta: chunks[i],
        };
        res.write(
            `event: content_block_delta\ndata: ${JSON.stringify(chunkEvent)}\n\n`,
        );
        i++;
    }, 100);
}

function handleAnthropicToolUseStreamResponse(
    res: ServerResponse,
    data: any,
): void {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });

    const events = [
        {
            event: "message_start",
            data: {
                type: "message_start",
                message: {
                    id: `msg_${Date.now()}`,
                    type: "message",
                    role: "assistant",
                    content: [],
                    model: data.model || "claude-3-5-sonnet-20241022",
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 14, output_tokens: 0 },
                },
            },
        },
        {
            event: "content_block_start",
            data: {
                type: "content_block_start",
                index: 0,
                content_block: {
                    type: "tool_use",
                    id: "toolu_001",
                    name: "get_weather",
                    input: {},
                },
            },
        },
        {
            event: "content_block_delta",
            data: {
                type: "content_block_delta",
                index: 0,
                delta: {
                    type: "input_json_delta",
                    partial_json: "{\"city\":\"San",
                },
            },
        },
        {
            event: "content_block_delta",
            data: {
                type: "content_block_delta",
                index: 0,
                delta: {
                    type: "input_json_delta",
                    partial_json: " Francisco\",\"unit\":\"celsius\"}",
                },
            },
        },
        {
            event: "content_block_stop",
            data: {
                type: "content_block_stop",
                index: 0,
            },
        },
        {
            event: "message_delta",
            data: {
                type: "message_delta",
                delta: {
                    stop_reason: "tool_use",
                    stop_sequence: null,
                },
                usage: { output_tokens: 11 },
            },
        },
        {
            event: "message_stop",
            data: {
                type: "message_stop",
            },
        },
    ];

    let i = 0;
    const interval = setInterval(() => {
        if (i >= events.length) {
            res.end();
            clearInterval(interval);
            return;
        }

        res.write(`event: ${events[i].event}\ndata: ${JSON.stringify(events[i].data)}\n\n`);
        i++;
    }, 100);
}

/**
 * Handle GET /v1/models - returns a fixed list of mock models
 */
function handleModelsList(_req: IncomingMessage, res: ServerResponse): void {
    const response = {
        object: "list",
        data: [
            { id: "mock-gpt-4o", object: "model", created: 1234567890, owned_by: "mock" },
            { id: "mock-gpt-4o-mini", object: "model", created: 1234567890, owned_by: "mock" },
            { id: "mock-gpt-3.5-turbo", object: "model", created: 1234567890, owned_by: "mock" },
            // Non-LLM entries that should be filtered out
            { id: "mock-whisper-1", object: "model", created: 1234567890, owned_by: "mock" },
            { id: "mock-dall-e-3", object: "model", created: 1234567890, owned_by: "mock" },
        ],
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
}


/**
 * OpenAI stream that closes without sending [DONE] (simulates stream_incomplete)
 */
function handleOpenAIStreamIncomplete(req: IncomingMessage, res: ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk.toString(); });
    req.on("end", () => {
        const data = body ? JSON.parse(body) : {};

        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });

        // Send 2 partial chunks then close without [DONE]
        const partialChunks = [
            { role: "assistant", content: "Hello" },
            { content: "..." },
        ];
        let i = 0;
        const interval = setInterval(() => {
            if (i >= partialChunks.length) {
                // Close without sending [DONE]
                res.end();
                clearInterval(interval);
                return;
            }
            const chunk = {
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: data.model || "gpt-3.5-turbo",
                choices: [{ index: 0, delta: partialChunks[i], finish_reason: null }],
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            i++;
        }, 50);
    });
}


/**
 * OpenAI stream that destroys the socket mid-stream (simulates upstream_disconnected)
 */
function handleOpenAIStreamDisconnect(req: IncomingMessage, res: ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk.toString(); });
    req.on("end", () => {
        const data = body ? JSON.parse(body) : {};

        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });

        // Send 1 chunk, then destroy socket abruptly
        const chunk = {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: data.model || "gpt-3.5-turbo",
            choices: [{ index: 0, delta: { role: "assistant", content: "Hi" }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);

        setTimeout(() => {
            res.socket?.destroy();
        }, 50);
    });
}


/**
 * Anthropic stream that closes without message_stop (simulates stream_incomplete)
 */
function handleAnthropicStreamIncomplete(req: IncomingMessage, res: ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk.toString(); });
    req.on("end", () => {
        const data = body ? JSON.parse(body) : {};

        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });

        const startEvent = {
            type: "message_start",
            message: {
                id: `msg_${Date.now()}`,
                type: "message",
                role: "assistant",
                content: [],
                model: data.model || "claude-3-haiku-20240307",
                stop_reason: null,
                usage: { input_tokens: 8, output_tokens: 0 },
            },
        };
        res.write(`event: message_start\ndata: ${JSON.stringify(startEvent)}\n\n`);

        // Send one delta then close without message_stop
        setTimeout(() => {
            const deltaEvent = {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "Hello" },
            };
            res.write(`event: content_block_delta\ndata: ${JSON.stringify(deltaEvent)}\n\n`);
            // Close without message_stop
            res.end();
        }, 50);
    });
}


/**
 * Responses API stream that closes without response.completed (simulates stream_incomplete)
 */
function handleResponsesStreamIncomplete(req: IncomingMessage, res: ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => { body += chunk.toString(); });
    req.on("end", () => {
        const data = body ? JSON.parse(body) : {};
        const respId = `resp_mock_${Date.now()}`;
        const now = Math.floor(Date.now() / 1000);
        const model = data.model || "gpt-4o";

        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });

        const baseResponse = {
            id: respId,
            object: "response",
            created_at: now,
            model,
            status: "in_progress",
            output: [],
            error: null,
            incomplete_details: null,
            instructions: null,
            reasoning: { effort: "none", summary: null },
            temperature: 1.0,
            tool_choice: "auto",
            tools: [],
            usage: null,
            completed_at: null,
        };

        res.write(`data: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: { ...baseResponse } })}\n\n`);

        // Send one delta then close without response.completed
        setTimeout(() => {
            res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", sequence_number: 1, output_index: 0, content_index: 0, delta: "Hello" })}\n\n`);
            // Close without response.completed
            res.end();
        }, 50);
    });
}


/**
 * Handle 404 Not Found
 */
function handleNotFound(res: ServerResponse): void {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
}

/**
 * Handle 400 Bad Request
 */
function handleBadRequest(res: ServerResponse, message: string): void {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
}

/**
 * Get received headers from last request
 */
function getReceivedHeaders(): Record<string, string> {
    return receivedHeaders;
}

/**
 * Clear received headers
 */
function clearReceivedHeaders(): void {
    receivedHeaders = {};
}

export default {
    startMockServer,
    stopMockServer,
    isMockServerRunning,
    initMockLogger,
    getReceivedHeaders,
    clearReceivedHeaders,
};
