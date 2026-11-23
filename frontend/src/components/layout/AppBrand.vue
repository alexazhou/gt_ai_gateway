<template>
    <div class="app-brand" :class="{ 'app-brand--collapsed': collapsed }">
        <img
            src="/favicon.svg"
            alt="Logo"
            class="logo"
            :data-tauri-drag-region="isMacOverlay ? 'false' : undefined"
            @click="handleLogoClick"
        >
        <span v-if="!collapsed" class="title">{{ title }}</span>
    </div>
</template>

<script setup lang="ts">
import { message } from 'ant-design-vue/es';
import { useAppStore } from '@/stores/app';
import { isMacTauri } from '@/utils/platform';

withDefaults(defineProps<{ collapsed?: boolean }>(), {
    collapsed: false,
});

// macOS 下 logo 位于窗口拖动区内，需阻止从 logo 上发起拖动以便响应点击
const isMacOverlay = isMacTauri();
const appStore = useAppStore();

const title = 'GT AI Gateway';

let logoClickCount = 0;
let logoClickTimer: number | null = null;

function handleLogoClick() {
    if (appStore.isDeveloperMode) return;

    logoClickCount++;
    if (logoClickTimer) {
        clearTimeout(logoClickTimer);
    }

    logoClickTimer = window.setTimeout(() => {
        logoClickCount = 0;
    }, 3000); // 3秒内连按才算

    if (logoClickCount >= 10) {
        appStore.enableDeveloperMode();
        message.success('已开启开发者模式');
        logoClickCount = 0;
    }
}
</script>

<style scoped>
.app-brand {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
}

.app-brand--collapsed {
    justify-content: center;
}

.logo {
    width: 26px;
    height: 26px;
    object-fit: contain;
    flex: none;
}

.title {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    white-space: nowrap;
}
</style>
