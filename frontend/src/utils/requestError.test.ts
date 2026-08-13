import { describe, it, expect } from 'vitest';
import { extractErrorMessage, createHttpError, AppRequestError } from './requestError';

describe('extractErrorMessage', () => {
    it('返回非空字符串原始内容', () => {
        expect(extractErrorMessage('Bad Request')).toBe('Bad Request');
    });

    it('空字符串使用 fallback', () => {
        expect(extractErrorMessage('', 'HTTP 400')).toBe('HTTP 400');
    });

    it('null / undefined / 非对象使用 fallback', () => {
        expect(extractErrorMessage(null, 'HTTP 400')).toBe('HTTP 400');
        expect(extractErrorMessage(undefined, 'HTTP 400')).toBe('HTTP 400');
        expect(extractErrorMessage(42, 'HTTP 400')).toBe('HTTP 400');
    });

    it('JSON 对象直接序列化展示（OpenAI 标准格式）', () => {
        const data = {
            error: {
                message: 'model parameter is missing or invalid',
                type: 'invalid_request_error',
                param: null,
                code: 'invalid_request_error',
            },
        };
        expect(extractErrorMessage(data)).toBe(JSON.stringify(data, null, 2));
    });

    it('JSON 对象直接序列化展示（Anthropic 标准格式）', () => {
        const data = {
            type: 'error',
            error: {
                type: 'invalid_request_error',
                message: 'model parameter is missing or invalid',
            },
        };
        expect(extractErrorMessage(data)).toBe(JSON.stringify(data, null, 2));
    });

    it('JSON 对象直接序列化展示（非标准 detail 格式）', () => {
        const data = { detail: 'upstream nonstandard error: quota exceeded', code: 429001 };
        expect(extractErrorMessage(data)).toBe(JSON.stringify(data, null, 2));
    });

    it('JSON 对象直接序列化展示（顶层 message 格式）', () => {
        const data = { message: 'top-level message field' };
        expect(extractErrorMessage(data)).toBe(JSON.stringify(data, null, 2));
    });

    it('空对象 {} 序列化为 "{}"', () => {
        expect(extractErrorMessage({}, 'HTTP 400')).toBe('{}');
    });

    it('纯文本响应体（非 JSON）直接返回文本', () => {
        expect(extractErrorMessage('Bad Request: upstream text error', 'HTTP 400'))
            .toBe('Bad Request: upstream text error');
    });
});

describe('createHttpError', () => {
    it('保留 status 与序列化后的 message', () => {
        const error = createHttpError(400, { error: { message: 'bad model' } }, 'HTTP 400');
        expect(error).toBeInstanceOf(AppRequestError);
        expect(error.status).toBe(400);
        expect(error.message).toBe(JSON.stringify({ error: { message: 'bad model' } }, null, 2));
    });

    it('无法提取时使用 fallback', () => {
        const error = createHttpError(400, undefined, 'HTTP 400（无错误详情）');
        expect(error.status).toBe(400);
        expect(error.message).toBe('HTTP 400（无错误详情）');
    });
});
