<template>
    <div class="window-controls" :class="{ 'window-controls--light-backdrop': onLightBackdrop }">
        <button
            type="button"
            class="window-control"
            aria-label="最小化"
            title="最小化"
            @click="minimize"
        >
            <svg viewBox="0 0 10 10" aria-hidden="true">
                <path d="M0 5h10" />
            </svg>
        </button>
        <button
            type="button"
            class="window-control"
            :aria-label="isMaximized ? '还原' : '最大化'"
            :title="isMaximized ? '还原' : '最大化'"
            @click="toggleMaximize"
        >
            <svg v-if="isMaximized" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M2.5 2.5V0.5h7v7h-2" />
                <rect x="0.5" y="2.5" width="7" height="7" />
            </svg>
            <svg v-else viewBox="0 0 10 10" aria-hidden="true">
                <rect x="0.5" y="0.5" width="9" height="9" />
            </svg>
        </button>
        <button
            type="button"
            class="window-control window-control--close"
            aria-label="关闭"
            title="关闭"
            @click="close"
        >
            <svg viewBox="0 0 10 10" aria-hidden="true">
                <path d="M0 0l10 10M10 0L0 10" />
            </svg>
        </button>
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useThemeStore } from '@/stores/theme';

// Windows 无边框窗口的自绘标题栏按钮，仅渲染在 Tauri Windows 端
const isMaximized = ref(false);
let unlisten: (() => void) | null = null;

const route = useRoute();
const themeStore = useThemeStore();
// 登录页背景固定为浅色，深色主题下窗口按钮需改用深色图标
const onLightBackdrop = computed(() => route.name === 'Login' && themeStore.isDark);

async function getWindow() {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return getCurrentWindow();
}

async function minimize() {
    try {
        const win = await getWindow();
        await win.minimize();
    } catch (e) {
        console.error('最小化窗口失败:', e);
    }
}

async function toggleMaximize() {
    try {
        const win = await getWindow();
        await win.toggleMaximize();
    } catch (e) {
        console.error('切换窗口最大化失败:', e);
    }
}

async function close() {
    try {
        const win = await getWindow();
        await win.close();
    } catch (e) {
        console.error('关闭窗口失败:', e);
    }
}

onMounted(async () => {
    try {
        const win = await getWindow();
        isMaximized.value = await win.isMaximized();
        unlisten = await win.onResized(async () => {
            isMaximized.value = await win.isMaximized();
        });
    } catch (e) {
        console.error('监听窗口状态失败:', e);
    }
});

onUnmounted(() => {
    if (unlisten) unlisten();
});
</script>

<style scoped>
.window-controls {
    position: fixed;
    top: 0;
    right: 0;
    z-index: 1000;
    display: flex;
    height: 32px;
}

.window-control {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 46px;
    height: 32px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text-primary);
    cursor: default;
    transition: background-color 0.15s ease, color 0.15s ease;
}

.window-control:hover {
    background: var(--window-control-hover);
}

.window-control--close:hover {
    background: #c42b1c;
    color: #ffffff;
}

.window-controls--light-backdrop .window-control {
    color: rgba(15, 23, 42, 0.75);
}

.window-controls--light-backdrop .window-control:hover {
    background: rgba(15, 23, 42, 0.08);
}

.window-controls--light-backdrop .window-control--close:hover {
    background: #c42b1c;
    color: #ffffff;
}

.window-control svg {
    width: 10px;
    height: 10px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1;
    shape-rendering: crispEdges;
}
</style>
