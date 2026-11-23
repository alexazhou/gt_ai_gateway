<template>
    <a-button
        type="text"
        class="theme-btn"
        :class="`theme-btn--${size}`"
        @click="toggleTheme"
    >
        <svg v-if="themeStore.isDark" v-bind="strokeIconProps">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2.5v2.2" />
            <path d="M12 19.3v2.2" />
            <path d="M4.93 4.93l1.56 1.56" />
            <path d="M17.51 17.51l1.56 1.56" />
            <path d="M2.5 12h2.2" />
            <path d="M19.3 12h2.2" />
            <path d="M4.93 19.07l1.56-1.56" />
            <path d="M17.51 6.49l1.56-1.56" />
        </svg>
        <svg v-else v-bind="strokeIconProps">
            <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a7.8 7.8 0 1 0 10.5 10.5Z" />
        </svg>
    </a-button>
</template>

<script setup lang="ts">
import { message } from 'ant-design-vue/es';
import { useThemeStore } from '@/stores/theme';

withDefaults(defineProps<{ size?: 'normal' | 'small' }>(), {
    size: 'normal',
});

const themeStore = useThemeStore();

const strokeIconProps = {
    viewBox: '0 0 24 24',
    width: '1em',
    height: '1em',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.6',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
} as const;

function toggleTheme() {
    themeStore.toggleTheme();
    message.success(`已切换为${themeStore.isDark ? '浅色' : '深色'}模式`);
}
</script>

<style scoped>
.theme-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
}

.theme-btn--normal {
    width: 36px;
    height: 36px;
    font-size: 20px;
}

.theme-btn--small {
    width: 28px;
    height: 28px;
    font-size: 18px;
}

.theme-btn :deep(svg) {
    display: block;
    width: 18px;
    height: 18px;
    flex: none;
}

.theme-btn--small :deep(svg) {
    width: 16px;
    height: 16px;
}
</style>
