import config from "../config";

/**
 * Model Test Data Fixtures
 */

const MODEL_FIXTURES = {
    basic: (vendorId: number) => createModel("test-model", vendorId),
    gpt35: (vendorId: number) => {
        const upstreamConfig = config.getCurrentUpstreamConfig();
        return createModel(upstreamConfig.openai.model, vendorId);
    },
    gpt4: (vendorId: number) => createModel("gpt-4", vendorId),
    claudeHaiku: (vendorId: number) => {
        const upstreamConfig = config.getCurrentUpstreamConfig();
        return createModel(upstreamConfig.anthropic.model, vendorId);
    },
    claudeSonnet: (vendorId: number) => createModel("claude-3-sonnet-20240229", vendorId),
};


function createModel(name: string, vendorId: number) {
    return {
        name,
        enable: true,
        prices: {},
        routing_mode: "single" as const,
        routing_config: {
            upstreams: [{
                vendor_id: vendorId,
                enabled: true,
            }],
        },
    };
}


function createRandomModel(vendorId: number, name?: string) {
    return createModel(name || `test-model-${Date.now()}`, vendorId);
}

export default {
    MODEL_FIXTURES,
    createRandomModel,
};
