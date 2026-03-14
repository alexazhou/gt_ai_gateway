import { createServer, IncomingMessage, ServerResponse } from "http";
import net from "net";
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

/**
 * Check if a port is in use
 */
function isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const tester = net.createServer()
            .once("error", () => {
                resolve(true);
            })
            .once("listening", () => {
                tester.once("close", () => {
                    resolve(false);
                }).close();
            })
            .listen(port);
    });
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

    // Check if port is already in use
    const portInUse = await isPortInUse(port);
    if (portInUse) {
        const errorMsg = `Port ${port} is already in use. Please stop any existing mock server or process using this port.`;
        mockLog(`Error: ${errorMsg}`);
        throw new Error(errorMsg);
    }

    return new Promise((resolve, reject) => {
        server = createServer((req: IncomingMessage, res: ServerResponse) => {
            handleRequest(req, res);
        });

        server.on("error", (err) => {
            if ((err as any).code === "EADDRINUSE") {
                const errorMsg = `Port ${port} is already in use. Please stop any existing mock server or process using this port.`;
                mockLog(`Error: ${errorMsg}`);
                reject(new Error(errorMsg));
            } else {
                mockLog(`Error: ${err}`);
                reject(err);
            }
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

    // Handle different endpoints
    if (url.includes("/chat/completions")) {
        handleOpenAIChat(req, res);
    } else if (url.includes("/messages")) {
        handleAnthropicMessages(req, res);
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
            // Send message_stop event with final usage
            const stopEvent = {
                type: "message_stop",
                usage: { input_tokens: 8, output_tokens: 12 },
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
