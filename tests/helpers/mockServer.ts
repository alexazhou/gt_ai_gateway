import { createServer, IncomingMessage, ServerResponse } from "http";

const DEFAULT_MOCK_PORT = 9999;

let server: ReturnType<typeof createServer> | null = null;
let isRunning = false;

/**
 * Store received headers for testing
 */
let receivedHeaders: Record<string, string> = {};

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
        return null;
    }

    return new Promise((resolve) => {
        server = createServer((req: IncomingMessage, res: ServerResponse) => {
            handleRequest(req, res);
        });

        server.listen(port, () => {
            isRunning = true;
            console.log(`Mock AI server listening on port ${port}`);
            resolve(server);
        });

        server.on("error", (err) => {
            console.error("Mock server error:", err);
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
    console.log("[MOCK] Received headers:", receivedHeaders);

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
    console.log(`[MOCK] ${req.method} ${url}`);

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

            if (isStream) {
                handleOpenAIStreamResponse(res, data);
            } else {
                handleOpenAINonStreamResponse(res, data);
            }
        } catch (e) {
            console.error("Error parsing request body:", e);
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
            // Send final chunk
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

            if (isStream) {
                handleAnthropicStreamResponse(res, data);
            } else {
                handleAnthropicNonStreamResponse(res, data);
            }
        } catch (e) {
            console.error("Error parsing request body:", e);
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
        { type: "content_block_delta", delta: { text: "Hello!" } },
        { type: "content_block_delta", delta: { text: " I am" } },
        { type: "content_block_delta", delta: { text: " a mock" } },
        { type: "content_block_delta", delta: { text: " Claude assistant." } },
        {
            type: "content_block_delta",
            delta: { text: " How can I help you?" },
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
            usage: { input_tokens: 10, output_tokens: 0 },
        },
    };
    res.write(`event: message_start\ndata: ${JSON.stringify(startEvent)}\n\n`);

    let i = 0;
    const interval = setInterval(() => {
        if (i >= chunks.length) {
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
            delta: chunks[i].delta,
        };
        res.write(
            `event: content_block_delta\ndata: ${JSON.stringify(chunkEvent)}\n\n`,
        );
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
    getReceivedHeaders,
    clearReceivedHeaders,
};
