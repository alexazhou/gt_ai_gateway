import { fetch, Headers } from "undici";

/**
 * Get test config dynamically to respect TEST_MODE at runtime
 */
async function getConfig() {
    // Dynamic import to ensure TEST_MODE is evaluated at runtime
    const config = await import("../config");
    return config.default;
}

/**
 * HTTP Request Helper
 * Provides convenient methods for making HTTP requests to the test server
 */

interface RequestOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
}

interface RequestResponse {
    ok: boolean;
    status: number;
    statusText: string;
    body: any;
    headers: Headers;
}

/**
 * Make a generic HTTP request
 */
async function request(
    endpoint: string,
    options: RequestOptions = {},
): Promise<RequestResponse> {
    const config = await getConfig();
    const url = `${config.SERVER_CONFIG.baseUrl}${endpoint}`;

    // worker 模式下服务端是 `wrangler dev`（miniflare 的本地代理），它会自行关闭空闲的
    // keep-alive 连接；undici 默认连接池可能把请求写到一条对面刚关掉的连接上，客户端看到的是
    // `TypeError: fetch failed` / `Caused by: SocketError: other side closed`（UND_ERR_SOCKET），
    // 而服务端日志里那条请求根本不存在（没到 handler）——是传输层竞态，不是接口行为问题。
    // 实测：全量 worker 门里 `tests/api/record/recoverOrphans.batch.test.ts` 约 2/3 概率撞上
    // （历史 2026-11-16 / 11-22 / 11-23 均有，与业务改动无关）。
    // 这里改成 worker 模式「一次请求一条连接」，从前提上消除该竞态；localhost 多一次握手可忽略。
    const noKeepAlive = config.TEST_MODE === "worker";

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(noKeepAlive ? { Connection: "close" } : {}),
        ...options.headers,
    };

    const response = await fetch(url, {
        ...options,
        headers,
    } as any);

    const body = await response.text();
    const parsedBody = body ? tryParseJSON(body) : body;

    return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        body: parsedBody,
        headers: response.headers,
    };
}

/**
 * Make a GET request
 */
async function get(endpoint: string, token?: string): Promise<RequestResponse> {
    const headers: Record<string, string> = {};
    if (token) {
        headers["Authorization"] = `Bearer ${token}`;
    }
    return request(endpoint, { method: "GET", headers });
}

/**
 * Make a POST request
 */
async function post(
    endpoint: string,
    body: any,
    token?: string,
    additionalHeaders?: Record<string, string>,
): Promise<RequestResponse> {
    const headers: Record<string, string> = {};
    if (token) {
        headers["Authorization"] = `Bearer ${token}`;
    }
    return request(endpoint, {
        method: "POST",
        headers: { ...headers, ...additionalHeaders },
        body: JSON.stringify(body),
    });
}

/**
 * Make a POST request with x-api-key header
 */
async function postWithAnthropicStyleApiKey(
    endpoint: string,
    body: any,
    apiKey: string,
): Promise<RequestResponse> {
    const headers: Record<string, string> = {
        "x-api-key": apiKey,
    };
    return request(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
    });
}

/**
 * Make a PUT request
 */
async function put(
    endpoint: string,
    body: any,
    token?: string,
): Promise<RequestResponse> {
    const headers: Record<string, string> = {};
    if (token) {
        headers["Authorization"] = `Bearer ${token}`;
    }
    return request(endpoint, {
        method: "PUT",
        headers: {
            ...headers,
        },
        body: JSON.stringify(body),
    });
}

/**
 * Make a DELETE request
 */
async function del(endpoint: string, token?: string): Promise<RequestResponse> {
    const headers: Record<string, string> = {};
    if (token) {
        headers["Authorization"] = `Bearer ${token}`;
    }
    return request(endpoint, { method: "DELETE", headers });
}

/**
 * Try to parse JSON, return original string if failed
 */
function tryParseJSON(str: string): any {
    try {
        return JSON.parse(str);
    } catch {
        return str;
    }
}

/**
 * 获取最近 N 条请求记录，并轮询直至它们完成落库（status 不再是 processing）。
 * 原因：Node 模式下响应结束后，record 的最终状态（success/failed）由 runInBackground 异步补齐，
 * MySQL 后端该写回的延迟可能晚于测试紧接着的读取，导致读到临时的 "processing"。此函数等它 settle。
 */
async function getFinalizedRecords(
    token: string,
    limit: number = 1,
    timeoutMs: number = 5000,
): Promise<any[]> {
    const deadline = Date.now() + timeoutMs;
    let last: any[] = [];
    for (;;) {
        const res = await get(`/record/latest.json?limit=${limit}`, token);
        const records = Array.isArray(res.body) ? res.body : [];
        last = records;
        const inFlight = records.filter((r: any) => r && r.status === "processing");
        if (records.length === 0 || inFlight.length === 0) {
            return records;
        }
        if (Date.now() >= deadline) {
            return records;
        }
        await new Promise((r) => setTimeout(r, 50));
    }
    return last;
}

export default {
    request,
    get,
    post,
    postWithAnthropicStyleApiKey,
    put,
    del,
    getFinalizedRecords,
};
