import { randomUUID } from "crypto";
import config from "../config";

/**
 * Vendor Test Data Fixtures
 */

const VENDOR_FIXTURES = {
    openai: () => {
        const upstreamConfig = config.getCurrentUpstreamConfig();
        return {
            type: "other",
            name: config.isRealMode ? "OpenAI" : "Mock OpenAI",
            token: config.isRealMode
                ? upstreamConfig.openai.apiKey
                : `openai-token-${randomUUID()}`,
            url: upstreamConfig.openai.url,
            api_format: "openai",
        };
    },
    anthropic: () => {
        const upstreamConfig = config.getCurrentUpstreamConfig();
        return {
            type: "other",
            name: config.isRealMode ? "Anthropic" : "Mock Anthropic",
            token: config.isRealMode
                ? upstreamConfig.anthropic.apiKey
                : `anthropic-token-${randomUUID()}`,
            url: upstreamConfig.anthropic.url,
            api_format: "anthropic",
        };
    },
    custom: {
        type: "other",
        name: "Custom Vendor",
        token: `custom-token-${randomUUID()}`,
        url: "https://api.custom.com/v1/chat",
        api_format: "openai",
    },
    aliyun: {
        type: "aliyun",
        name: "Aliyun Vendor",
        token: `aliyun-token-${randomUUID()}`,
        url: "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation",
        api_format: "openai",
    },
    deepseek: {
        type: "deepseek",
        name: "DeepSeek Vendor",
        token: `deepseek-token-${randomUUID()}`,
        url: "https://api.deepseek.com/v1/chat/completions",
        api_format: "openai",
    },
};

function createRandomVendor(
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
        url: overrides.url || "https://api.example.com/v1/chat",
        api_format: overrides.api_format || "openai",
    };
}

export default {
    VENDOR_FIXTURES,
    createRandomVendor,
};
