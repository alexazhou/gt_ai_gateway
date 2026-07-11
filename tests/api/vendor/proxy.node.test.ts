/**
 * 供应商代理配置集成测试
 *
 * 验证完整推理链路：
 * - SOCKS5 代理：Gateway → Mock SOCKS5 → Mock AI Server → 返回推理结果
 * - HTTP 代理：Gateway → Mock HTTP Proxy → Mock AI Server → 返回推理结果
 * - 无代理：Gateway → Mock AI Server → 返回推理结果
 * - 代理不可达：返回失败
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import requestHelper from "../../helpers/requestHelper";
import dbHelper from "../../helpers/dbHelper";


const ROOT_TOKEN = "root-token-123";
const MOCK_PROXY_URL = "http://localhost:9997";
const MOCK_SOCKS_URL = "socks5://localhost:9996";
const MOCK_SERVER_URL = "http://localhost:9999";
const SOCKS_QUERY_URL = "http://localhost:10096";


async function getSocksConnections(): Promise<Array<{ host: string; port: number }>> {
    const resp = await fetch(`${SOCKS_QUERY_URL}/_test/connections`);
    return await resp.json() as any;
}

async function getProxyRequests(): Promise<Array<{ method: string; url: string }>> {
    const resp = await fetch(`${MOCK_PROXY_URL}/_test/requests`);
    return await resp.json() as any;
}


describe("Vendor Proxy Configuration", () => {
    beforeAll(async () => {
        await dbHelper.truncate();
    });

    beforeEach(async () => {
        await fetch(`${MOCK_PROXY_URL}/_test/requests`, { method: "DELETE" });
        await fetch(`${SOCKS_QUERY_URL}/_test/connections`, { method: "DELETE" });
    });

    it("should get inference result through SOCKS5 proxy", async () => {
        // 创建走 SOCKS5 代理的供应商
        const vendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "SOCKS5 Vendor",
                token: "test-token",
                urls: { openai: `${MOCK_SERVER_URL}/v1/chat/completions` },
                config: {
                    proxy: { type: "socks5", url: MOCK_SOCKS_URL },
                },
            },
            ROOT_TOKEN,
        );

        // 测试连通性
        const response = await requestHelper.post(
            `/vendor/${vendor.body.id}/test.json`,
            { format: "openai", model: "mock-gpt-4o" },
            ROOT_TOKEN,
        );

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.status).toBe(200);

        // 验证响应包含推理结果
        expect(response.body.response).toBeDefined();
        expect(response.body.response.choices).toBeDefined();
        expect(response.body.response.choices.length).toBeGreaterThan(0);
        expect(response.body.response.choices[0].message.content).toBeDefined();

        // 验证请求经过了 SOCKS5 代理
        const connections = await getSocksConnections();
        expect(connections.length).toBeGreaterThanOrEqual(1);
        expect(connections[0].host).toContain("localhost");
    });

    it("should get inference result through HTTP proxy", async () => {
        // 创建走 HTTP 代理的供应商
        const vendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "HTTP Proxy Vendor",
                token: "test-token",
                urls: { openai: `${MOCK_SERVER_URL}/v1/chat/completions` },
                config: {
                    proxy: { type: "http", url: MOCK_PROXY_URL },
                },
            },
            ROOT_TOKEN,
        );

        // 测试连通性
        const response = await requestHelper.post(
            `/vendor/${vendor.body.id}/test.json`,
            { format: "openai", model: "mock-gpt-4o" },
            ROOT_TOKEN,
        );

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.status).toBe(200);

        // 验证响应包含推理结果
        expect(response.body.response).toBeDefined();
        expect(response.body.response.choices).toBeDefined();
        expect(response.body.response.choices.length).toBeGreaterThan(0);
        expect(response.body.response.choices[0].message.content).toBeDefined();

        // 验证请求经过了 HTTP 代理
        const requests = await getProxyRequests();
        expect(requests.length).toBeGreaterThanOrEqual(1);
    });

    it("should get inference result without proxy", async () => {
        // 创建不走代理的供应商
        const vendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Direct Vendor",
                token: "test-token",
                urls: { openai: `${MOCK_SERVER_URL}/v1/chat/completions` },
                config: {},
            },
            ROOT_TOKEN,
        );

        // 测试连通性
        const response = await requestHelper.post(
            `/vendor/${vendor.body.id}/test.json`,
            { format: "openai", model: "mock-gpt-4o" },
            ROOT_TOKEN,
        );

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.status).toBe(200);

        // 验证响应包含推理结果
        expect(response.body.response).toBeDefined();
        expect(response.body.response.choices).toBeDefined();
        expect(response.body.response.choices.length).toBeGreaterThan(0);
        expect(response.body.response.choices[0].message.content).toBeDefined();

        // 验证请求没有经过代理
        const proxyRequests = await getProxyRequests();
        expect(proxyRequests.length).toBe(0);
        const socksConnections = await getSocksConnections();
        expect(socksConnections.length).toBe(0);
    });

    it("should return failure when proxy is unreachable", async () => {
        // 创建走不存在代理的供应商
        const vendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Bad Proxy Vendor",
                token: "test-token",
                urls: { openai: `${MOCK_SERVER_URL}/v1/chat/completions` },
                config: {
                    proxy: { type: "http", url: "http://localhost:19999" },
                },
            },
            ROOT_TOKEN,
        );

        const response = await requestHelper.post(
            `/vendor/${vendor.body.id}/test.json`,
            { format: "openai", model: "mock-gpt-4o" },
            ROOT_TOKEN,
        );

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(false);
        expect(response.body.error).toBeDefined();
    });

    it("should update vendor proxy config and get inference result", async () => {
        // 创建不走代理的供应商
        const vendor = await requestHelper.post(
            "/vendor/create.json",
            {
                type: "other",
                name: "Update Proxy Vendor",
                token: "test-token",
                urls: { openai: `${MOCK_SERVER_URL}/v1/chat/completions` },
                config: {},
            },
            ROOT_TOKEN,
        );

        // 先直接测试（无代理）
        const directResponse = await requestHelper.post(
            `/vendor/${vendor.body.id}/test.json`,
            { format: "openai", model: "mock-gpt-4o" },
            ROOT_TOKEN,
        );
        expect(directResponse.body.success).toBe(true);
        expect(directResponse.body.response.choices[0].message.content).toBeDefined();

        // 更新为走 SOCKS5 代理
        await requestHelper.put(
            `/vendor/${vendor.body.id}`,
            {
                config: {
                    proxy: { type: "socks5", url: MOCK_SOCKS_URL },
                },
            },
            ROOT_TOKEN,
        );

        // 再测试（走代理）
        const proxyResponse = await requestHelper.post(
            `/vendor/${vendor.body.id}/test.json`,
            { format: "openai", model: "mock-gpt-4o" },
            ROOT_TOKEN,
        );
        expect(proxyResponse.body.success).toBe(true);
        expect(proxyResponse.body.response.choices[0].message.content).toBeDefined();

        // 验证经过了 SOCKS5 代理
        const connections = await getSocksConnections();
        expect(connections.length).toBeGreaterThanOrEqual(1);
    });
});
