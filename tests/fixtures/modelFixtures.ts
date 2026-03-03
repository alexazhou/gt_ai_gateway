import config from "../config";

/**
 * Model Test Data Fixtures
 */

const MODEL_FIXTURES = {
    basic: (vendorId: number) => ({
        name: "test-model",
        vendor_id: vendorId,
    }),
    gpt35: (vendorId: number) => {
        const upstreamConfig = config.getCurrentUpstreamConfig();
        return {
            name: upstreamConfig.openai.model,
            vendor_id: vendorId,
        };
    },
    gpt4: (vendorId: number) => ({
        name: "gpt-4",
        vendor_id: vendorId,
    }),
    claudeHaiku: (vendorId: number) => {
        const upstreamConfig = config.getCurrentUpstreamConfig();
        return {
            name: upstreamConfig.anthropic.model,
            vendor_id: vendorId,
        };
    },
    claudeSonnet: (vendorId: number) => ({
        name: "claude-3-sonnet-20240229",
        vendor_id: vendorId,
    }),
};

function createRandomModel(vendorId: number, name?: string) {
    return {
        name: name || `test-model-${Date.now()}`,
        vendor_id: vendorId,
    };
}

export default {
    MODEL_FIXTURES,
    createRandomModel,
};
