/**
 * Model Test Data Fixtures
 */

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
    createRandomModel,
};
