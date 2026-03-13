import { fetchEventSource } from '@microsoft/fetch-event-source';
import type { ApiTestRequest, StreamChunk } from '@/types/gateway';

interface StreamCallbacks {
    onMessage?: (content: string) => void;
    onComplete?: () => void;
    onError?: (error: string) => void;
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

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

    const token = localStorage.getItem('adminToken');

    if (!stream) {
        // 非流式请求
        try {
            const response = await fetch(`${API_BASE_URL}/v1/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': token ? `Bearer ${token}` : '',
                },
                body: JSON.stringify(requestBody),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: '请求失败' }));
                const errorMsg = typeof errorData.error === 'object' 
                    ? (errorData.error.message || JSON.stringify(errorData.error)) 
                    : (errorData.error || errorData.message || `HTTP ${response.status}`);
                throw new Error(errorMsg);
            }

            const result = await response.json();
            const content = result.choices?.[0]?.message?.content || '';
            callbacks.onMessage?.(content);
            callbacks.onComplete?.();
        } catch (error: any) {
            callbacks.onError?.(error.message || '请求失败');
        }
        return;
    }

    // 流式请求
    let fullContent = '';

    try {
        await fetchEventSource(`${API_BASE_URL}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': token ? `Bearer ${token}` : '',
            },
            body: JSON.stringify(requestBody),
            async onopen(response) {
                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({ error: '请求失败' }));
                    const errorMsg = typeof errorData.error === 'object' 
                        ? (errorData.error.message || JSON.stringify(errorData.error)) 
                        : (errorData.error || errorData.message || `HTTP ${response.status}`);
                    throw new Error(errorMsg);
                }
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
                // 如果 onopen 抛出了错误，这里会捕获到
                callbacks.onError?.(err.message || '流式请求失败');
                throw err;
            },
        });
    } catch (error: any) {
        // 这里也会捕获到错误
        callbacks.onError?.(error.message || '请求失败');
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

    const requestBody: any = {
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

    const token = localStorage.getItem('adminToken');

    if (!stream) {
        // 非流式请求
        try {
            const response = await fetch(`${API_BASE_URL}/v1/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': token ? `Bearer ${token}` : '',
                },
                body: JSON.stringify(requestBody),
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: '请求失败' }));
                const errorMsg = typeof errorData.error === 'object' 
                    ? (errorData.error.message || JSON.stringify(errorData.error)) 
                    : (errorData.error || errorData.message || `HTTP ${response.status}`);
                throw new Error(errorMsg);
            }

            const result = await response.json();
            const content = result.content?.[0]?.text || '';
            callbacks.onMessage?.(content);
            callbacks.onComplete?.();
        } catch (error: any) {
            callbacks.onError?.(error.message || '请求失败');
        }
        return;
    }

    // 流式请求
    let fullContent = '';

    try {
        await fetchEventSource(`${API_BASE_URL}/v1/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': token ? `Bearer ${token}` : '',
            },
            body: JSON.stringify(requestBody),
            async onopen(response) {
                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({ error: '请求失败' }));
                    const errorMsg = typeof errorData.error === 'object' 
                        ? (errorData.error.message || JSON.stringify(errorData.error)) 
                        : (errorData.error || errorData.message || `HTTP ${response.status}`);
                    throw new Error(errorMsg);
                }
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
                callbacks.onError?.(err.message || '流式请求失败');
                throw err;
            },
        });
    } catch (error: any) {
        callbacks.onError?.(error.message || '请求失败');
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
