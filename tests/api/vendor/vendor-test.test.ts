import { describe, it, expect, beforeAll } from 'vitest';
import requestHelper from '../../helpers/requestHelper';
import dbHelper from '../../helpers/dbHelper';
import upstreamCaptureHelper from '../../helpers/upstreamCaptureHelper';
import { TEST_IMAGE_BASE64, TEST_IMAGE_DATA_URL, TEST_IMAGE_PROMPT } from '../../../src/util/protocol/testRequestUtil';

describe('Vendor Test API', () => {
    let rootToken = 'root-token-123';

    beforeAll(async () => {
        await dbHelper.truncate();
    });

    it('should test vendor connectivity (OpenAI format)', async () => {
        // Create a vendor pointing to our mock server
        const vendor = await requestHelper.post('/vendor/create.json', {
            type: 'other',
            name: 'Test Vendor',
            token: 'test-token',
            urls: {
                openai: 'http://localhost:9999/v1/chat/completions'
            }
        }, rootToken);

        const response = await requestHelper.post(`/vendor/${vendor.body.id}/test.json`, {
            format: 'openai',
            model: 'gpt-4'
        }, rootToken);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body).toHaveProperty('duration');
        expect(response.body).toHaveProperty('status', 200);
    });

    it('should test vendor connectivity with custom model', async () => {
        const vendor = await requestHelper.post('/vendor/create.json', {
            type: 'other',
            name: 'Custom Model Vendor',
            token: 'test-token',
            urls: {
                openai: 'http://localhost:9999/v1/chat/completions'
            }
        }, rootToken);

        const response = await requestHelper.post(`/vendor/${vendor.body.id}/test.json`, {
            format: 'openai',
            model: 'special-model-123'
        }, rootToken);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
    });

    it('should test vendor connectivity (Anthropic format)', async () => {
        const vendor = await requestHelper.post('/vendor/create.json', {
            type: 'other',
            name: 'Test Anthropic',
            token: 'test-token',
            urls: {
                anthropic: 'http://localhost:9999/v1/messages'
            }
        }, rootToken);

        const response = await requestHelper.post(`/vendor/${vendor.body.id}/test.json`, {
            format: 'anthropic',
            model: 'claude-3-opus'
        }, rootToken);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body).toHaveProperty('status', 200);
    });

    it('should return failure for invalid URL', async () => {
        const vendor = await requestHelper.post('/vendor/create.json', {
            type: 'other',
            name: 'Invalid URL Vendor',
            token: 'test-token',
            urls: {
                openai: 'http://localhost:12345/invalid' // Non-existent port
            }
        }, rootToken);

        const response = await requestHelper.post(`/vendor/${vendor.body.id}/test.json`, {
            format: 'openai'
        }, rootToken);

        // fetch will throw, our controller returns 200 (test result wrapper)
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(false);
        expect(response.body).toHaveProperty('error');
    });

    it('should use api_key auth by default for Anthropic vendors', async () => {
        const vendor = await requestHelper.post('/vendor/create.json', {
            type: 'other',
            name: 'API Key Auth Vendor',
            token: 'sk-ant-test-key',
            urls: {
                anthropic: 'http://localhost:9999/v1/messages'
            }
        }, rootToken);

        const response = await requestHelper.post(`/vendor/${vendor.body.id}/test.json`, {
            format: 'anthropic',
            model: 'claude-3-opus'
        }, rootToken);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
    });

    it('should use bearer_token auth when configured', async () => {
        const vendor = await requestHelper.post('/vendor/create.json', {
            type: 'other',
            name: 'Bearer Token Auth Vendor',
            token: 'sk-ant-bearer-key',
            urls: {
                anthropic: 'http://localhost:9999/v1/messages'
            },
            config: { auth_mode: 'bearer_token' }
        }, rootToken);

        const response = await requestHelper.post(`/vendor/${vendor.body.id}/test.json`, {
            format: 'anthropic',
            model: 'claude-3-opus'
        }, rootToken);

        // mock server 也接受 Bearer token，所以应该成功
        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
    });

    it('should use api_key auth when explicitly configured', async () => {
        const vendor = await requestHelper.post('/vendor/create.json', {
            type: 'other',
            name: 'Explicit API Key Vendor',
            token: 'sk-ant-explicit-key',
            urls: {
                anthropic: 'http://localhost:9999/v1/messages'
            },
            config: { auth_mode: 'api_key' }
        }, rootToken);

        const response = await requestHelper.post(`/vendor/${vendor.body.id}/test.json`, {
            format: 'anthropic',
            model: 'claude-3-opus'
        }, rootToken);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
    });

    // ─── 多模态（content_mode）────────────────────────────────────────────────
    // 断言分两层：① 接口回显的 request_body（= 实际发出的 body）② mock 上游真的收到了图片
    // 单看 ① 只能证明「我们以为发了」，两者都要才算「上游收到了符合协议规范的图片」。

    it('text 模式回归：不传 content_mode 时仍发 ping，且回显 content_mode=text', async () => {
        const vendor = await requestHelper.post('/vendor/create.json', {
            type: 'other',
            name: 'Regression Text Vendor',
            token: 'test-token',
            urls: { openai: 'http://localhost:9999/v1/chat/completions' }
        }, rootToken);

        const response = await requestHelper.post(`/vendor/${vendor.body.id}/test.json`, {
            format: 'openai',
            model: 'gpt-4'
        }, rootToken);

        expect(response.status).toBe(200);
        expect(response.body.content_mode).toBe('text');
        expect(response.body.request_body.messages[0].content).toBe('ping');
        expect(response.body.request_body.max_tokens).toBe(5);
        expect(response.body.request_body).not.toHaveProperty('stream');
    });

    it('image 模式（OpenAI）：上游收到 [text, image_url] 且是 data:image/png;base64', async () => {
        const vendor = await requestHelper.post('/vendor/create.json', {
            type: 'other',
            name: 'Multimodal OpenAI Vendor',
            token: 'test-token',
            urls: { openai: 'http://localhost:9999/v1/chat/completions' }
        }, rootToken);

        const response = await requestHelper.post(`/vendor/${vendor.body.id}/test.json`, {
            format: 'openai',
            model: 'gpt-4o',
            content_mode: 'image'
        }, rootToken);

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.content_mode).toBe('image');

        const body = response.body.request_body;
        expect(body.max_tokens).toBe(64);
        expect(Array.isArray(body.messages[0].content)).toBe(true);
        expect(body.messages[0].content[0]).toEqual({ type: 'text', text: TEST_IMAGE_PROMPT });
        expect(body.messages[0].content[1]).toEqual({
            type: 'image_url',
            image_url: { url: TEST_IMAGE_DATA_URL },
        });

        // 第二层：mock 上游捕获到的最后一条请求里确实带图片
        const captured = await upstreamCaptureHelper.list();
        const last = captured[captured.length - 1];
        expect(last.json.model).toBe('gpt-4o');
        expect(last.json.messages[0].content[1].image_url.url).toBe(TEST_IMAGE_DATA_URL);
    });

    it('image 模式（Anthropic）：图在前、文本在后，source 为 base64 + image/png', async () => {
        const vendor = await requestHelper.post('/vendor/create.json', {
            type: 'other',
            name: 'Multimodal Anthropic Vendor',
            token: 'test-token',
            urls: { anthropic: 'http://localhost:9999/v1/messages' }
        }, rootToken);

        const response = await requestHelper.post(`/vendor/${vendor.body.id}/test.json`, {
            format: 'anthropic',
            model: 'claude-3-opus',
            content_mode: 'image'
        }, rootToken);

        expect(response.status).toBe(200);
        expect(response.body.content_mode).toBe('image');

        const content = response.body.request_body.messages[0].content;
        expect(content[0].type).toBe('image');
        expect(content[0].source).toEqual({
            type: 'base64',
            media_type: 'image/png',
            data: TEST_IMAGE_BASE64,
        });
        expect(content[1]).toEqual({ type: 'text', text: TEST_IMAGE_PROMPT });
        // 图片模式必须放宽 max_tokens，否则视觉问答会被 1 个 token 截断
        expect(response.body.request_body.max_tokens).toBe(64);

        const captured = await upstreamCaptureHelper.list();
        const last = captured[captured.length - 1];
        expect(last.json.messages[0].content[0].type).toBe('image');
        expect(last.json.messages[0].content[0].source.media_type).toBe('image/png');
    });

    it('image 模式（Responses）：input 数组里 input_image.image_url 是字符串', async () => {
        const vendor = await requestHelper.post('/vendor/create.json', {
            type: 'other',
            name: 'Multimodal Responses Vendor',
            token: 'test-token',
            urls: { responses: 'http://localhost:9999/v1/responses' }
        }, rootToken);

        const response = await requestHelper.post(`/vendor/${vendor.body.id}/test.json`, {
            format: 'responses',
            model: 'gpt-5',
            content_mode: 'image'
        }, rootToken);

        expect(response.status).toBe(200);
        expect(response.body.content_mode).toBe('image');

        const body = response.body.request_body;
        expect(body.max_output_tokens).toBe(64);
        expect(body.input[0].content[0]).toEqual({ type: 'input_text', text: TEST_IMAGE_PROMPT });
        expect(body.input[0].content[1].type).toBe('input_image');
        expect(typeof body.input[0].content[1].image_url).toBe('string');
        expect(body.input[0].content[1].image_url).toBe(TEST_IMAGE_DATA_URL);
    });

    it('非法 content_mode 返回 400（不静默降级成 text）', async () => {
        const vendor = await requestHelper.post('/vendor/create.json', {
            type: 'other',
            name: 'Invalid Content Mode Vendor',
            token: 'test-token',
            urls: { openai: 'http://localhost:9999/v1/chat/completions' }
        }, rootToken);

        for (const bad of ['IMAGE', 'img', 'base64', 1]) {
            const response = await requestHelper.post(`/vendor/${vendor.body.id}/test.json`, {
                format: 'openai',
                model: 'gpt-4',
                content_mode: bad
            }, rootToken);
            expect(response.status, `content_mode=${String(bad)} 应返回 400`).toBe(400);
        }
    });
});
