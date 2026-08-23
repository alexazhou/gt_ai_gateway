import { randomUUID } from "crypto";
import config from "../config";

/**
 * Vendor Test Data Fixtures
 */

// 多租户隔离下供应商名租户内唯一：mock 模式每次调用生成唯一 name/token，
// 避免同一文件内多次建 vendor 时撞名（真实模式仍用固定供应商名）
const VENDOR_FIXTURES = {
    openai: () => {
        const upstreamConfig = config.getCurrentUpstreamConfig();
        return {
            type: "other",
            name: config.isRealMode ? "OpenAI" : `Mock OpenAI ${randomUUID().slice(0, 8)}`,
            token: config.isRealMode
                ? upstreamConfig.openai.apiKey
                : `openai-token-${randomUUID()}`,
            urls: {
                openai: upstreamConfig.openai.url,
            },
        };
    },
    anthropic: () => {
        const upstreamConfig = config.getCurrentUpstreamConfig();
        return {
            type: "other",
            name: config.isRealMode ? "Anthropic" : `Mock Anthropic ${randomUUID().slice(0, 8)}`,
            token: config.isRealMode
                ? upstreamConfig.anthropic.apiKey
                : `anthropic-token-${randomUUID()}`,
            urls: {
                anthropic: upstreamConfig.anthropic.url,
            },
        };
    },
    custom: {
        type: "other",
        name: "Custom Vendor",
        token: `custom-token-${randomUUID()}`,
        urls: {
            openai: "https://api.custom.com/v1/chat",
        },
    },
    aliyun: {
        type: "aliyun",
        name: "Aliyun Vendor",
        token: `aliyun-token-${randomUUID()}`,
        urls: {
            openai: "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation",
        },
    },
    deepseek: {
        type: "deepseek",
        name: "DeepSeek Vendor",
        token: `deepseek-token-${randomUUID()}`,
        urls: {
            openai: "https://api.deepseek.com/v1/chat/completions",
        },
    },
};

function createRandomVendor(
    overrides: Partial<{
        type: string;
        name: string;
        token: string;
        urls: Record<string, string>;
    }> = {},
) {
    return {
        type: overrides.type || "other",
        name: overrides.name || `Test Vendor ${Date.now()}`,
        token: overrides.token || `vendor-token-${randomUUID()}`,
        urls: overrides.urls || { openai: "https://api.example.com/v1/chat" },
    };
}

export default {
    VENDOR_FIXTURES,
    createRandomVendor,
};
