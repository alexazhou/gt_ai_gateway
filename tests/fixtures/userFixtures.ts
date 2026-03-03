import { randomUUID } from "crypto";

/**
 * User Test Data Fixtures
 */

const USER_FIXTURES = {
    basic: {
        name: "Test User",
        token: randomUUID(),
    },
    withCustomToken: {
        name: "Test User with Custom Token",
        token: "custom-token-123",
    },
    duplicateName1: {
        name: "Duplicate User",
        token: randomUUID(),
    },
    duplicateName2: {
        name: "Duplicate User",
        token: randomUUID(),
    },
    longName: {
        name: "A".repeat(255),
        token: randomUUID(),
    },
    // 空字符串 token 会被自动生成新的 UUID（在 userController 中处理）
    emptyToken: {
        name: "Test User",
        token: "",
    },
};

function createRandomUser(name?: string, token?: string) {
    return {
        name: name || `Test User ${Date.now()}`,
        token: token || randomUUID(),
    };
}

export default {
    USER_FIXTURES,
    createRandomUser,
};
