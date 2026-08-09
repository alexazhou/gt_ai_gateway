import { randomUUID } from "crypto";

/**
 * User Test Data Fixtures
 */

// 测试环境预设的管理员 Token（唯一来源，各处统一引用，避免重复定义导致不一致）
const ADMIN_TOKEN = "admin-token-for-test";

const USER_FIXTURES = {
    basic: {
        name: "Test User",
        token: randomUUID(),
    },
    admin: {
        name: "Admin User",
        token: ADMIN_TOKEN,
        type: "admin",
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
    ADMIN_TOKEN,
};
