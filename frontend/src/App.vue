<template>
    <a-config-provider :theme="themeConfig">
        <div :class="['app-container', themeStore.isDark ? 'dark' : 'light']">
            <router-view />
        </div>
    </a-config-provider>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useThemeStore } from '@/stores/theme';

const themeStore = useThemeStore();

const themeConfig = computed(() => themeStore.getAntdThemeConfig());
</script>

<style>
* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

html, body {
    height: 100%;
}

body {
    background: #f0f2f5;
}

html.dark body {
    background: #141414;
}

#app {
    height: 100%;
}

.app-container {
    height: 100%;
}

/* Light 模式 */
.app-container.light {
    --bg-layout: #f0f2f5;
    --bg-header: #ffffff;
    --bg-sidebar: #ffffff;
    --bg-sidebar-gradient: linear-gradient(180deg, #ffffff 0%, #fbfcff 100%);
    --bg-card: #ffffff;
    --bg-page: #ffffff;
    --bg-info-item: #fafafa;
    --bg-code: #f6f8fa;
    --bg-code-header: #ffffff;
    --component-bg: #ffffff;
    --border-color: #e8edf5;
    --border-info-item: #f0f0f0;
    --text-primary: #243247;
    --text-secondary: #8c8c8c;
    --text-sidebar: #243247;
    --text-sidebar-icon: #5b6b83;
    --text-version: #95a1b2;
    --text-description: #666;
    --sidebar-hover: #eef5ff;
    --sidebar-selected: #dcebff;
    --sidebar-selected-border: transparent;
    --sidebar-selected-text: var(--accent-primary);
    --sidebar-hover-text: var(--accent-primary);
    --collapse-btn-bg: #f4f7fb;
    --collapse-btn-text: #4f5d75;
    --token-divider: #d9d9d9;
    --tag-default-border: #d9d9d9;
    --accent-primary: #258fff;
    --accent-primary-hover: #4aa4ff;
    --accent-primary-soft: rgba(37, 143, 255, 0.16);
    --accent-primary-border: rgba(37, 143, 255, 0.28);
    --toolbar-btn-bg: #258fff;
    --toolbar-btn-bg-hover: #1f7ae0;
    --toolbar-btn-text: #ffffff;
    --toolbar-switch-off: rgba(15, 23, 42, 0.18);
    --toolbar-switch-handle: #ffffff;
    --btn-primary-bg: #258fff;
    --btn-primary-bg-hover: #1f7ae0;
    --btn-primary-border: rgba(37, 143, 255, 0.34);
    --btn-primary-text: #ffffff;
    --btn-default-bg: rgba(255, 255, 255, 0.96);
    --btn-default-bg-hover: #ffffff;
    --btn-default-border: #d7e3f5;
    --btn-default-border-hover: rgba(37, 143, 255, 0.34);
    --btn-default-text: #243247;
    --scrollbar-track: rgba(15, 23, 42, 0.06);
    --scrollbar-thumb: rgba(90, 105, 125, 0.28);
    --scrollbar-thumb-hover: rgba(90, 105, 125, 0.42);
    --accent-danger: #ff6b6b;
    --accent-danger-soft: rgba(255, 107, 107, 0.12);
    --accent-danger-border: rgba(255, 107, 107, 0.24);
    --accent-warning: #d46b08;
    --accent-warning-soft: rgba(212, 107, 8, 0.12);
    --accent-warning-border: rgba(212, 107, 8, 0.22);
}

/* Dark 模式 */
.app-container.dark {
    --bg-layout: #141414;
    --bg-header: #1f1f1f;
    --bg-sidebar: #1f1f1f;
    --bg-sidebar-gradient: linear-gradient(180deg, #1f1f1f 0%, #1a1a1a 100%);
    --bg-card: #1f1f1f;
    --bg-page: #1f1f1f;
    --bg-info-item: #262626;
    --bg-code: #171717;
    --bg-code-header: #202020;
    --component-bg: #1f1f1f;
    --border-color: #303030;
    --border-info-item: #303030;
    --text-primary: rgba(255, 255, 255, 0.85);
    --text-secondary: rgba(255, 255, 255, 0.45);
    --text-sidebar: rgba(255, 255, 255, 0.85);
    --text-sidebar-icon: rgba(255, 255, 255, 0.65);
    --text-version: rgba(255, 255, 255, 0.45);
    --text-description: rgba(255, 255, 255, 0.45);
    --sidebar-hover: #223043;
    --sidebar-selected: #263f5d;
    --sidebar-selected-border: transparent;
    --sidebar-selected-text: var(--accent-primary);
    --sidebar-hover-text: var(--accent-primary);
    --collapse-btn-bg: rgba(255, 255, 255, 0.08);
    --collapse-btn-text: rgba(255, 255, 255, 0.65);
    --token-divider: rgba(255, 255, 255, 0.15);
    --tag-default-border: #424242;
    --accent-primary: #409cff;
    --accent-primary-hover: #66b2ff;
    --accent-primary-soft: rgba(64, 156, 255, 0.20);
    --accent-primary-border: rgba(94, 176, 255, 0.28);
    --toolbar-btn-bg: #3478c6;
    --toolbar-btn-bg-hover: #409cff;
    --toolbar-btn-text: rgba(255, 255, 255, 0.96);
    --toolbar-switch-off: rgba(255, 255, 255, 0.18);
    --toolbar-switch-handle: #ffffff;
    --btn-primary-bg: #3478c6;
    --btn-primary-bg-hover: #409cff;
    --btn-primary-border: rgba(94, 176, 255, 0.28);
    --btn-primary-text: rgba(255, 255, 255, 0.96);
    --btn-default-bg: rgba(255, 255, 255, 0.04);
    --btn-default-bg-hover: rgba(255, 255, 255, 0.08);
    --btn-default-border: rgba(255, 255, 255, 0.12);
    --btn-default-border-hover: rgba(94, 176, 255, 0.22);
    --btn-default-text: rgba(255, 255, 255, 0.85);
    --scrollbar-track: rgba(255, 255, 255, 0.05);
    --scrollbar-thumb: rgba(255, 255, 255, 0.16);
    --scrollbar-thumb-hover: rgba(255, 255, 255, 0.28);
    --accent-danger: #ff7875;
    --accent-danger-soft: rgba(255, 120, 117, 0.14);
    --accent-danger-border: rgba(255, 120, 117, 0.28);
    --accent-warning: #f2a654;
    --accent-warning-soft: rgba(242, 166, 84, 0.14);
    --accent-warning-border: rgba(242, 166, 84, 0.26);
}

.app-container .ant-btn {
    box-shadow: none;
    transition: background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease;
}

.app-container .ant-btn-primary:not(.ant-btn-dangerous):not([disabled]) {
    background: var(--btn-primary-bg);
    border-color: var(--btn-primary-border);
    color: var(--btn-primary-text);
}

.app-container .ant-btn-primary:not(.ant-btn-dangerous):not([disabled]):hover,
.app-container .ant-btn-primary:not(.ant-btn-dangerous):not([disabled]):focus {
    background: var(--btn-primary-bg-hover);
    border-color: var(--btn-primary-bg-hover);
    color: var(--btn-primary-text);
}

.app-container .ant-btn-default:not(.ant-btn-dangerous):not([disabled]),
.app-container .ant-btn-dashed:not(.ant-btn-dangerous):not([disabled]) {
    background: var(--btn-default-bg);
    border-color: var(--btn-default-border);
    color: var(--btn-default-text);
}

.app-container .ant-btn-default:not(.ant-btn-dangerous):not([disabled]):hover,
.app-container .ant-btn-default:not(.ant-btn-dangerous):not([disabled]):focus,
.app-container .ant-btn-dashed:not(.ant-btn-dangerous):not([disabled]):hover,
.app-container .ant-btn-dashed:not(.ant-btn-dangerous):not([disabled]):focus {
    background: var(--btn-default-bg-hover);
    border-color: var(--btn-default-border-hover);
    color: var(--accent-primary);
}

body,
body * {
    scrollbar-width: thin;
    scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-track);
}

body ::-webkit-scrollbar {
    width: 10px;
    height: 10px;
}

body ::-webkit-scrollbar-track {
    background: var(--scrollbar-track);
}

body ::-webkit-scrollbar-thumb {
    background: var(--scrollbar-thumb);
    border-radius: 999px;
    border: 2px solid transparent;
    background-clip: padding-box;
}

body ::-webkit-scrollbar-thumb:hover {
    background: var(--scrollbar-thumb-hover);
    border: 2px solid transparent;
    background-clip: padding-box;
}

body ::-webkit-scrollbar-corner {
    background: transparent;
}

.ant-message {
    top: 24px;
}

.ant-message .ant-message-notice-wrapper {
    padding: 6px 0;
}

.ant-message .ant-message-notice-content {
    border-radius: 18px;
    border: 1px solid rgba(15, 23, 42, 0.08);
    background: rgba(255, 255, 255, 0.96);
    box-shadow: 0 18px 40px rgba(15, 23, 42, 0.12);
    color: #243247;
    padding: 14px 18px;
    backdrop-filter: blur(16px);
}

.ant-message .ant-message-custom-content {
    display: flex;
    align-items: center;
    gap: 10px;
    font-weight: 600;
}

html.dark .ant-message .ant-message-notice-content {
    border-color: rgba(96, 165, 250, 0.18);
    background: linear-gradient(180deg, rgba(39, 46, 58, 0.96) 0%, rgba(31, 37, 48, 0.98) 100%);
    box-shadow: 0 22px 52px rgba(0, 0, 0, 0.46), 0 0 0 1px rgba(255, 255, 255, 0.04) inset;
    color: rgba(255, 255, 255, 0.92);
}
</style>
