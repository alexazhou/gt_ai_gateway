import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import sseAccumulator from "../../src/util/sseAccumulator";

/**
 * SSE 累加器测试
 * 使用实际记录的流式响应文件测试累加器功能
 */

describe("SSE Accumulator", () => {
    const resourceDir = join(__dirname, "..", "resource");

    describe("Anthropic Streaming", () => {
        it("should correctly accumulate Anthropic streaming response with thinking and text", () => {
            const logFile = join(resourceDir, "anthropic-stream.log");

            if (!existsSync(logFile)) {
                console.log(`Log file not found: ${logFile}, skipping test`);
                return;
            }

            const content = readFileSync(logFile, "utf-8");

            console.log("Raw log file content (first 200 chars):", content.substring(0, 200));

            // 按 \n 分割 SSE 事件（某些系统可能将 \n\n 转换为 \n）
            // 先尝试按 \n\n 分割，如果失败则按单行并组合相邻行
            let events: string[];
            if (content.includes("\n\n")) {
                events = content.split("\n\n").filter(e => e.trim());
            } else {
                // 按单行分割，然后组合成事件
                const lines = content.split("\n").filter(line => line.trim());
                events = [];
                let currentEvent = "";
                for (const line of lines) {
                    if (line.startsWith("event:")) {
                        if (currentEvent) {
                            events.push(currentEvent);
                        }
                        currentEvent = line;
                    } else {
                        currentEvent += "\n" + line;
                    }
                }
                if (currentEvent) {
                    events.push(currentEvent);
                }
            }

            console.log("Total events found:", events.length);
            console.log("First event:", events[0]);

            const accumulator = new sseAccumulator.SSEAccumulator("anthropic");

            // 逐个处理 SSE 事件
            for (const event of events) {
                if (!event.trim()) continue;

                // 解析 SSE event 中的各字段行（data / event / id / retry）
                const lines = event.split("\n");
                let data = "";
                let eventType = "";
                let id = "";
                for (const line of lines) {
                    if (line.startsWith("data:")) {
                        data = line.slice(5).trim();
                    } else if (line.startsWith("event:")) {
                        eventType = line.slice(6).trim();
                    } else if (line.startsWith("id:")) {
                        id = line.slice(3).trim();
                    }
                }

                if (!data) continue;

                if (data === "[DONE]") continue;

                try {
                    const parsedData = JSON.parse(data);
                    console.log(`Processing event: ${eventType}, data:`, JSON.stringify(parsedData).substring(0, 100));
                    accumulator.addMessage(parsedData, eventType);
                } catch (e) {
                    console.log("Failed to parse SSE data:", data, e);
                }
            }

            const response = accumulator.getResponse();

            // 验证基本字段
            expect(response.id).toBeDefined();
            expect(response.model).toBeDefined();
            expect(response.choices).toBeDefined();
            expect(response.choices.length).toBeGreaterThan(0);

            // 验证 message 结构
            const message = response.choices[0].message;
            expect(message).toHaveProperty("content");
            expect(message).toHaveProperty("role");
            expect(message.role).toBe("assistant");

            // 验证 content 不为空
            expect(message.content.length).toBeGreaterThan(0);

            // 验证 usage
            expect(response.usage).toBeDefined();
            expect(response.usage?.prompt_tokens).toBeDefined();
            expect(response.usage?.completion_tokens).toBeDefined();

            console.log("Response:", JSON.stringify(response, null, 2));
        });

        it("should correctly parse thinking and signature from content_block_delta", () => {
            const logFile = join(resourceDir, "anthropic-stream.log");

            if (!existsSync(logFile)) {
                console.log(`Log file not found: ${logFile}, skipping test`);
                return;
            }

            const content = readFileSync(logFile, "utf-8");
            const events = content.split("\n\n").filter(e => e.trim());

            const accumulator = new sseAccumulator.SSEAccumulator("anthropic");

            let foundThinkingDelta = false;
            let foundSignatureDelta = false;
            let foundTextDelta = false;

            for (const event of events) {
                if (!event.trim()) continue;

                const lines = event.split("\n");
                let data = "";
                let eventType = "";
                for (const line of lines) {
                    if (line.startsWith("data:")) {
                        data = line.slice(5).trim();
                    } else if (line.startsWith("event:")) {
                        eventType = line.slice(6).trim();
                    }
                }

                if (!data) continue;

                if (data === "[DONE]") continue;

                try {
                    const parsedData = JSON.parse(data);

                    // 检查不同的 delta 类型
                    if (eventType === 'content_block_delta') {
                        const deltaType = (parsedData as any).delta?.type;
                        if (deltaType === 'thinking_delta') {
                            foundThinkingDelta = true;
                        } else if (deltaType === 'signature_delta') {
                            foundSignatureDelta = true;
                        } else if (deltaType === 'text_delta') {
                            foundTextDelta = true;
                        }
                    }

                    accumulator.addMessage(parsedData, eventType);
                } catch (e) {
                    console.log("Failed to parse SSE data:", data, e);
                }
            }

            const response = accumulator.getResponse();
            const message = response.choices[0].message;

            console.log("Found delta types - thinking:", foundThinkingDelta, "signature:", foundSignatureDelta, "text:", foundTextDelta);

            // 如果日志中有 thinking_delta，验证 thinking 字段
            if (foundThinkingDelta) {
                expect(message.thinking).toBeDefined();
                expect(message.thinking!.length).toBeGreaterThan(0);
                console.log("Thinking content length:", message.thinking!.length);
            }

            // 如果日志中有 signature_delta，验证 signature 字段
            if (foundSignatureDelta) {
                expect(message.signature).toBeDefined();
                expect(message.signature!.length).toBeGreaterThan(0);
                console.log("Signature:", message.signature);
            }

            // 验证 text_delta 被正确处理
            if (foundTextDelta) {
                expect(message.content.length).toBeGreaterThan(0);
                console.log("Text content:", message.content);
            }
        });

        it("should correctly handle message_delta for stop_reason", () => {
            const logFile = join(resourceDir, "anthropic-stream.log");

            if (!existsSync(logFile)) {
                console.log(`Log file not found: ${logFile}, skipping test`);
                return;
            }

            const content = readFileSync(logFile, "utf-8");
            const events = content.split("\n\n").filter(e => e.trim());

            const accumulator = new sseAccumulator.SSEAccumulator("anthropic");
            let foundMessageDelta = false;

            for (const event of events) {
                if (!event.trim()) continue;

                const lines = event.split("\n");
                let data = "";
                let eventType = "";
                for (const line of lines) {
                    if (line.startsWith("data:")) {
                        data = line.slice(5).trim();
                    } else if (line.startsWith("event:")) {
                        eventType = line.slice(6).trim();
                    }
                }

                if (!data) continue;

                if (data === "[DONE]") continue;

                try {
                    const parsedData = JSON.parse(data);

                    if (eventType === 'message_delta') {
                        foundMessageDelta = true;
                        console.log("message_delta data:", parsedData);
                    }

                    accumulator.addMessage(parsedData, eventType);
                } catch (e) {
                    console.log("Failed to parse SSE data:", data, e);
                }
            }

            const response = accumulator.getResponse();

            if (foundMessageDelta) {
                console.log("Finish reason:", response.choices[0].finish_reason);
                // stop_reason 应该从 message_delta 中获取
                expect(response.choices[0].finish_reason).toBeDefined();
            }
        });
    });

    describe("OpenAI Streaming", () => {
        it("should correctly accumulate OpenAI streaming response", () => {
            const logFile = join(resourceDir, "openai-stream.log");

            if (!existsSync(logFile)) {
                console.log(`Log file not found: ${logFile}, skipping test`);
                return;
            }

            const content = readFileSync(logFile, "utf-8");
            const events = content.split("\n\n");

            const accumulator = new sseAccumulator.SSEAccumulator("openai");

            for (const event of events) {
                if (!event.trim()) continue;

                const dataMatch = event.match(/^data:\s*(.+)$/m);

                if (dataMatch) {
                    const data = dataMatch[1];

                    if (data === "[DONE]") continue;

                    try {
                        const parsedData = JSON.parse(data);
                        accumulator.addMessage(parsedData);
                    } catch (e) {
                        console.log("Failed to parse SSE data:", data, e);
                    }
                }
            }

            const response = accumulator.getResponse();

            // 验证基本字段
            expect(response.id).toBeDefined();
            expect(response.object).toBeDefined();
            expect(response.model).toBeDefined();
            expect(response.choices).toBeDefined();
            expect(response.choices.length).toBeGreaterThan(0);

            // 验证 content
            const message = response.choices[0].message;
            expect(message.content.length).toBeGreaterThan(0);

            console.log("OpenAI Response:", JSON.stringify(response, null, 2));
        });

        it("should correctly handle role and content deltas", () => {
            const logFile = join(resourceDir, "openai-stream.log");

            if (!existsSync(logFile)) {
                console.log(`Log file not found: ${logFile}, skipping test`);
                return;
            }

            const content = readFileSync(logFile, "utf-8");
            const events = content.split("\n\n");

            const accumulator = new sseAccumulator.SSEAccumulator("openai");
            let foundRoleDelta = false;
            let foundContentDeltas = false;

            for (const event of events) {
                if (!event.trim()) continue;

                const dataMatch = event.match(/^data:\s*(.+)$/m);

                if (dataMatch) {
                    const data = dataMatch[1];

                    if (data === "[DONE]") continue;

                    try {
                        const parsedData = JSON.parse(data);

                        const choice = parsedData.choices[0];
                        if (choice.delta?.role) {
                            foundRoleDelta = true;
                        }
                        if (choice.delta?.content) {
                            foundContentDeltas = true;
                        }

                        accumulator.addMessage(parsedData);
                    } catch (e) {
                        console.log("Failed to parse SSE data:", data, e);
                    }
                }
            }

            const response = accumulator.getResponse();
            const message = response.choices[0].message;

            console.log("Found role delta:", foundRoleDelta, "Found content deltas:", foundContentDeltas);

            // 验证 role 被正确设置
            if (foundRoleDelta) {
                expect(message.role).toBe("assistant");
            }

            // 验证 content 被正确累积
            if (foundContentDeltas) {
                expect(message.content.length).toBeGreaterThan(0);
                // 验证累积的内容是否正确
                expect(message.content).toContain("Hello");
                expect(message.content).toContain("mock AI assistant");
            }

            console.log("Final content:", message.content);
        });

        it("should correctly handle usage information from final chunk", () => {
            const logFile = join(resourceDir, "openai-stream.log");

            if (!existsSync(logFile)) {
                console.log(`Log file not found: ${logFile}, skipping test`);
                return;
            }

            const content = readFileSync(logFile, "utf-8");
            const events = content.split("\n\n");

            const accumulator = new sseAccumulator.SSEAccumulator("openai");
            let foundUsageChunk = false;

            for (const event of events) {
                if (!event.trim()) continue;

                const dataMatch = event.match(/^data:\s*(.+)$/m);

                if (dataMatch) {
                    const data = dataMatch[1];

                    if (data === "[DONE]") continue;

                    try {
                        const parsedData = JSON.parse(data);

                        if (parsedData.usage) {
                            foundUsageChunk = true;
                            console.log("Usage chunk:", JSON.stringify(parsedData.usage));
                        }

                        accumulator.addMessage(parsedData);
                    } catch (e) {
                        console.log("Failed to parse SSE data:", data, e);
                    }
                }
            }

            const response = accumulator.getResponse();

            console.log("Found usage chunk:", foundUsageChunk);

            if (foundUsageChunk) {
                // 验证 usage 被正确记录
                expect(response.usage).toBeDefined();
                expect(response.usage?.prompt_tokens).toBeDefined();
                expect(response.usage?.completion_tokens).toBeDefined();
                expect(response.usage?.total_tokens).toBeDefined();

                console.log("Final usage:", response.usage);
            }

            // 验证 finish_reason
            expect(response.choices[0].finish_reason).toBe("stop");
        });
    });
});