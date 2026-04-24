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
 * Generate a mock vendor
 */
function generateVendor(
    overrides: Partial<{
        type: string;
        name: string;
        token: string;
        url: string;
        api_format: string;
    }> = {},
) {
    return {
        type: overrides.type || "other",
        name: overrides.name || `Test Vendor ${Date.now()}`,
        token: overrides.token || `vendor-token-${randomUUID()}`,
        url: overrides.url || "http://localhost:9999",
        api_format: overrides.api_format || "openai",
    };
}

/**
 * Generate a mock OpenAI vendor
 */
function generateOpenAIVendor() {
    const upstreamConfig = config.getCurrentUpstreamConfig();
    return generateVendor({
        type: "other",
        name: config.isRealMode ? "OpenAI" : "Mock OpenAI",
        api_format: "openai",
        url: upstreamConfig.openai.url,
        token: config.isRealMode
            ? upstreamConfig.openai.apiKey
            : `openai-token-${randomUUID()}`,
    });
}

/**
 * Generate a mock Anthropic vendor
 */
function generateAnthropicVendor() {
    const upstreamConfig = config.getCurrentUpstreamConfig();
    return generateVendor({
        type: "other",
        name: config.isRealMode ? "Anthropic" : "Mock Anthropic",
        api_format: "anthropic",
        url: upstreamConfig.anthropic.url,
        token: config.isRealMode
            ? upstreamConfig.anthropic.apiKey
            : `anthropic-token-${randomUUID()}`,
    });
}

/**
 * Generate a mock model
 */
function generateModel(
    vendorId: number,
    overrides: Partial<{ name: string }> = {},
) {
    return {
        name: overrides.name || `test-model-${Date.now()}`,
        vendor_id: vendorId,
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
    }> = {},
) {
    return {
        model: overrides.model || "gpt-4o",
        input: overrides.input || "Hello!",
        stream: overrides.stream ?? false,
    };
}

/**
 * Generate a random string
 */
function randomString(length: number = 10): string {
    const chars =
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let result = "";
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

/**
 * Generate a random number
 */
function randomNumber(min: number = 1, max: number = 100): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Generate a random email
 */
function randomEmail(): string {
    return `${randomString(8).toLowerCase()}@example.com`;
}

export default {
    generateUser,
    generateVendor,
    generateOpenAIVendor,
    generateAnthropicVendor,
    generateModel,
    generateOpenAIChatRequest,
    generateAnthropicMessageRequest,
    generateResponsesRequest,
    randomString,
    randomNumber,
    randomEmail,
};
