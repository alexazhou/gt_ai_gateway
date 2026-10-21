import type posthog from 'posthog-js';

declare global {
    interface Window {
        /** 由 main.ts 注入，供非组件模块读取 PostHog 状态 */
        posthog?: typeof posthog;
    }
}

export {};
