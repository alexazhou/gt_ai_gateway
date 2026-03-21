import { fetchEventSource } from '@microsoft/fetch-event-source';
import type { ApiTestRequest, StreamChunk } from '@/types/gateway';
import { getAuthToken } from '@/utils/authSession';
import { createHttpError, toAppRequestError } from '@/utils/requestError';

interface StreamCallbacks {
    onMessage?: (content: string) => void;
    onComplete?: () => void;
    onError?: (error: string) => void;
}

interface ChatCompletionResponse {
    choices?: Array<{
        message?: {
            content?: string;
        };
    }>;
}

interface AnthropicMessageResponse {
    content?: Array<{
        text?: string;
    }>;
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

async function parseErrorResponse(response: Response): Promise<unknown> {
    return response.json().catch(() => undefined);
}

async function ensureOk(response: Response, fallback: string = '请求失败'): Promise<void> {
    if (!response.ok) {
        throw createHttpError(response.status, await parseErrorResponse(response), fallback);
    }
}

/**
 * 发送 Chat Completions 请求（支持流式）
 */
export async function chatCompletions(
    data: ApiTestRequest,
    callbacks: StreamCallbacks,
): Promise<void> {
    const { model, messages, temperature, max_tokens, stream } = data;

    const requestBody = {
        model,
        messages,
        temperature,
        max_tokens,
        stream: stream ?? false,
    };

    const token = getAuthToken();

    if (!stream) {
        // 非流式请求
        try {
            const response = await fetch(`${API_BASE_URL}/llm/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': token ? `Bearer ${token}` : '',
                },
                body: JSON.stringify(requestBody),
            });

            if (!response.ok) {
                throw createHttpError(response.status, await parseErrorResponse(response), `HTTP ${response.status}`);
            }

            const result = await response.json() as ChatCompletionResponse;
            const content = result.choices?.[0]?.message?.content || '';
            callbacks.onMessage?.(content);
            callbacks.onComplete?.();
        } catch (error) {
            callbacks.onError?.(toAppRequestError(error).message);
        }
        return;
    }

    // 流式请求
    let fullContent = '';

    try {
        await fetchEventSource(`${API_BASE_URL}/llm/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': token ? `Bearer ${token}` : '',
            },
            body: JSON.stringify(requestBody),
            async onopen(response) {
                await ensureOk(response, `HTTP ${response.status}`);
                return Promise.resolve();
            },
            onmessage(msg) {
                if (msg.data === '[DONE]') {
                    callbacks.onComplete?.();
                    return;
                }

                try {
                    const chunk: StreamChunk = JSON.parse(msg.data);
                    const content = chunk.choices?.[0]?.delta?.content || '';
                    if (content) {
                        fullContent += content;
                        callbacks.onMessage?.(fullContent);
                    }
                } catch {
                    // 忽略解析错误
                }
            },
            onclose() {
                callbacks.onComplete?.();
            },
            onerror(err) {
                const requestError = toAppRequestError(err, '流式请求失败');
                callbacks.onError?.(requestError.message);
                throw requestError;
            },
        });
    } catch (error) {
        callbacks.onError?.(toAppRequestError(error).message);
    }
}

/**
 * 发送 Anthropic Messages 请求
 */
export async function anthropicMessages(
    data: ApiTestRequest,
    callbacks: StreamCallbacks,
): Promise<void> {
    const { model, messages, temperature, max_tokens, stream } = data;

    // 提取 system 消息
    const systemMessage = messages.find(m => m.role === 'system');
    const otherMessages = messages.filter(m => m.role !== 'system');

    const requestBody: Record<string, unknown> = {
        model,
        messages: otherMessages.map(m => ({
            role: m.role,
            content: m.content,
        })),
        temperature,
        max_tokens: max_tokens || 1024,
        stream: stream ?? false,
    };

    if (systemMessage) {
        requestBody.system = systemMessage.content;
    }

    const token = getAuthToken();

    if (!stream) {
        // 非流式请求
        try {
            const response = await fetch(`${API_BASE_URL}/llm/v1/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': token ? `Bearer ${token}` : '',
                },
                body: JSON.stringify(requestBody),
            });

            if (!response.ok) {
                throw createHttpError(response.status, await parseErrorResponse(response), `HTTP ${response.status}`);
            }

            const result = await response.json() as AnthropicMessageResponse;
            const content = result.content?.[0]?.text || '';
            callbacks.onMessage?.(content);
            callbacks.onComplete?.();
        } catch (error) {
            callbacks.onError?.(toAppRequestError(error).message);
        }
        return;
    }

    // 流式请求
    let fullContent = '';

    try {
        await fetchEventSource(`${API_BASE_URL}/llm/v1/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': token ? `Bearer ${token}` : '',
            },
            body: JSON.stringify(requestBody),
            async onopen(response) {
                await ensureOk(response, `HTTP ${response.status}`);
                return Promise.resolve();
            },
            onmessage(msg) {
                if (msg.data === '[DONE]') {
                    callbacks.onComplete?.();
                    return;
                }

                try {
                    const chunk = JSON.parse(msg.data);
                    const content = chunk.delta?.text || '';
                    if (content) {
                        fullContent += content;
                        callbacks.onMessage?.(fullContent);
                    }
                } catch {
                    // 忽略解析错误
                }
            },
            onclose() {
                callbacks.onComplete?.();
            },
            onerror(err) {
                const requestError = toAppRequestError(err, '流式请求失败');
                callbacks.onError?.(requestError.message);
                throw requestError;
            },
        });
    } catch (error) {
        callbacks.onError?.(toAppRequestError(error).message);
    }
}

/**
 * 发送 API 测试请求
 */
export async function sendApiTest(
    data: ApiTestRequest,
    callbacks: StreamCallbacks,
): Promise<void> {
    if (data.format === 'anthropic') {
        return anthropicMessages(data, callbacks);
    }
    return chatCompletions(data, callbacks);
}
