import { join } from "path";
import { readFileSync, existsSync } from "fs";

/**
 * Test Configuration
 * Supports environment variables for flexible test configuration
 */

const PROJECT_ROOT = process.cwd();

const TEST_MODE = process.env.TEST_MODE || "node";

// Check if real API mode is enabled
const REAL_API_MODE = process.env.TEST_REAL_API === "true";

/**
 * Node Mode Server Configuration
 */
const NODE_SERVER_CONFIG = {
    baseUrl: process.env.TEST_BASE_URL || "http://localhost:3000",
    port: parseInt(process.env.TEST_PORT || "3000", 10),
};

/**
 * Worker Mode Server Configuration
 */
const WORKER_SERVER_CONFIG = {
    baseUrl: "http://localhost:8787",
    port: 8787,
};

/**
 * Server Configuration - dynamically selected based on TEST_MODE
 */
const SERVER_CONFIG =
    TEST_MODE === "worker" ? WORKER_SERVER_CONFIG : NODE_SERVER_CONFIG;

/**
 * Worker Configuration
 */
const WORKER_CONFIG = {
    port: 8787,
    startupTimeout: 30000, // 30 seconds for wrangler dev startup
};

/**
 * Database Configuration
 */
const DB_CONFIG = {
    path: process.env.TEST_DB_PATH || join(PROJECT_ROOT, "test.db"),
    mode: process.env.TEST_DB_MODE || "local",
};

/**
 * Load real API configuration from JSON file (only in real mode)
 */
function loadRealApiConfig() {
    // Only load config when in real API mode
    if (!REAL_API_MODE) {
        return null;
    }

    const configPath = join(PROJECT_ROOT, "resource", "test_real_config.json");

    if (!existsSync(configPath)) {
        console.warn(
            "Real API mode is enabled but config file not found:",
            configPath,
        );
        return null;
    }

    try {
        const configContent = readFileSync(configPath, "utf-8");
        return JSON.parse(configContent);
    } catch (e) {
        console.warn("Failed to load real API config:", e);
        return null;
    }
}

// Load real API configuration from JSON file (only in real mode)
const REAL_API_CONFIG = loadRealApiConfig();

/**
 * Upstream Mode Type
 */
type UpstreamMode = "mock" | "real";

/**
 * Check if real API mode is enabled
 */
const isRealMode = REAL_API_MODE;

/**
 * Check if mock server is enabled
 */
const useMockServer = !REAL_API_MODE;

/**
 * Upstream Service Configuration
 */
const UPSTREAM_CONFIG = {
    openai: {
        url:
            REAL_API_CONFIG?.openai?.url ||
            process.env.TEST_UPSTREAM_OPENAI_URL ||
            "https://api.openai.com/v1/chat/completions",
        apiKey:
            REAL_API_CONFIG?.openai?.apiKey ||
            process.env.TEST_UPSTREAM_OPENAI_API_KEY ||
            "",
        model:
            REAL_API_CONFIG?.openai?.model ||
            process.env.TEST_UPSTREAM_OPENAI_MODEL ||
            "gpt-3.5-turbo",
    },
    anthropic: {
        url:
            REAL_API_CONFIG?.anthropic?.url ||
            process.env.TEST_UPSTREAM_ANTHROPIC_URL ||
            "https://api.anthropic.com/v1/messages",
        apiKey:
            REAL_API_CONFIG?.anthropic?.apiKey ||
            process.env.TEST_UPSTREAM_ANTHROPIC_API_KEY ||
            "",
        model:
            REAL_API_CONFIG?.anthropic?.model ||
            process.env.TEST_UPSTREAM_ANTHROPIC_MODEL ||
            "claude-3-haiku-20240307",
    },
    mock: {
        enabled: !REAL_API_MODE,
        url: process.env.TEST_UPSTREAM_MOCK_URL || "http://localhost:9999",
    },
};

/**
 * Test Options
 */
const TEST_OPTIONS = {
    cleanup: process.env.TEST_CLEANUP !== "false",
    timeout: parseInt(process.env.TEST_TIMEOUT || "30000", 10),
    verbose: process.env.TEST_VERBOSE === "true",
};

/**
 * Get current upstream mode
 */
function getUpstreamMode(): UpstreamMode {
    return isRealMode ? "real" : "mock";
}

/**
 * Get current upstream configuration based on mode
 */
function getCurrentUpstreamConfig() {
    const mode = getUpstreamMode();

    if (mode === "real") {
        return {
            openai: UPSTREAM_CONFIG.openai,
            anthropic: UPSTREAM_CONFIG.anthropic,
        };
    }

    return {
        openai: {
            url: UPSTREAM_CONFIG.mock.url + "/chat/completions",
            apiKey: "",
            model: "gpt-3.5-turbo",
        },
        anthropic: {
            url: UPSTREAM_CONFIG.mock.url + "/messages",
            apiKey: "",
            model: "claude-3-haiku-20240307",
        },
    };
}

/**
 * Logging helper for verbose mode
 */
function logTest(...args: any[]) {
    if (TEST_OPTIONS.verbose) {
        console.log("[TEST]", ...args);
    }
}

export default {
    SERVER_CONFIG,
    DB_CONFIG,
    UPSTREAM_CONFIG,
    TEST_OPTIONS,
    WORKER_CONFIG,
    TEST_MODE,
    isRealMode,
    useMockServer,
    logTest,
    getUpstreamMode,
    getCurrentUpstreamConfig,
};
