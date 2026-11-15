import { randomUUID } from "crypto";
import config from "../config";

/**
 * Mock Data Generator
 * Provides helper functions to generate test data
 */

/**
 * Generate a mock user
 */
function generateUser(
    overrides: Partial<{ name: string; token: string }> = {},
) {
    return {
        name: overrides.name || `Test User ${Date.now()}`,
        token: overrides.token || randomUUID(),
    };
}

/**
 * Generate a mock OpenAI chat request
 */
function generateOpenAIChatRequest(
    overrides: Partial<{
        model: string;
        messages: any[];
        stream: boolean;
    }> = {},
) {
    const upstreamConfig = config.getCurrentUpstreamConfig();
    return {
        model: overrides.model || upstreamConfig.openai.model,
        messages: overrides.messages || [{ role: "user", content: "Hello!" }],
        stream: overrides.stream ?? false,
    };
}

/**
 * Generate a mock Anthropic messages request
 */
function generateAnthropicMessageRequest(
    overrides: Partial<{
        model: string;
        messages: any[];
        stream: boolean;
        max_tokens: number;
    }> = {},
) {
    const upstreamConfig = config.getCurrentUpstreamConfig();
    return {
        model: overrides.model || upstreamConfig.anthropic.model,
        messages: overrides.messages || [{ role: "user", content: "Hello!" }],
        stream: overrides.stream ?? false,
        max_tokens: overrides.max_tokens || 1024,
    };
}

/**
 * Generate a mock OpenAI Responses API request
 */
function generateResponsesRequest(
    overrides: Partial<{
        model: string;
        input: string;
        stream: boolean;
        cached_tokens: number;
    }> = {},
) {
    return {
        model: overrides.model || "gpt-4o",
        input: overrides.input || "Hello!",
        stream: overrides.stream ?? false,
        ...(overrides.cached_tokens !== undefined ? { cached_tokens: overrides.cached_tokens } : {}),
    };
}

export default {
    generateUser,
    generateOpenAIChatRequest,
    generateAnthropicMessageRequest,
    generateResponsesRequest,
};
