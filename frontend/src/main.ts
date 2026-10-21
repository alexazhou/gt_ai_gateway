import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { ConfigProvider } from 'ant-design-vue';
import App from './App.vue';
import router from './router';
import './style.css';
import { setBaseURL } from './utils/request';
import { setAuthToken } from './utils/authSession';
import posthog from 'posthog-js';

function loadBrowserStoredConfig(): void {
    const storedUrl = localStorage.getItem('backendBaseURL');
    if (storedUrl) {
        setBaseURL(storedUrl);
    }

    const token = localStorage.getItem('adminToken');
    if (token) {
        setAuthToken(token);
    }
}

import { isTauri } from '@/utils/platform';

async function loadDesktopRuntimeConfig(): Promise<boolean> {
    if (!isTauri()) {
        return false;
    }

    try {
        const { invoke } = await import('@tauri-apps/api/core');
        const [url, token] = await Promise.all([
            invoke<string>('get_backend_url'),
            invoke<string>('get_auth_token'),
        ]);

        console.log('[main] invoke result: url=' + url + ' token=' + (token || 'empty'));
        if (url) {
            setBaseURL(url);
        }

        if (token) {
            console.log('[main] calling setAuthToken with token=' + token.substring(0, 8) + '...');
            setAuthToken(token, { persist: false });
        }
    } catch (e) {
        console.error('Failed to load desktop runtime config:', e);
    }

    return true;
}

// Override console.log to also send to Rust for debugging
const _origLog = console.log.bind(console);
console.log = function(...args: unknown[]) {
    _origLog(...args);
    try {
        if (isTauri()) {
            import('@tauri-apps/api/core').then(({ invoke }) => {
                invoke('log_to_rust', { msg: args.map(String).join(' ') });
            }).catch(() => {});
        }
    } catch {}
};

async function bootstrap() {
    const loadedDesktopConfig = await loadDesktopRuntimeConfig();
    if (!loadedDesktopConfig) {
        loadBrowserStoredConfig();
    }

    const app = createApp(App);
    const pinia = createPinia();
    
    posthog.init('phc_ugm7dcRiZDbQhggrmJZFMuzmRaGUbnE2t4KgqM62FEyA', {
        api_host: 'https://us.i.posthog.com',
        person_profiles: 'identified_only',
        autocapture: false,
        capture_pageview: false,
        disable_session_recording: true,
        opt_out_capturing_by_default: true,
    });
    
    // Default to opt-in, we will opt-out later if the config says so
    // We attach it to window for easy access
    window.posthog = posthog;

    app.use(pinia);
    app.use(router);
    app.component('AConfigProvider', ConfigProvider);
    app.mount('#app');
}

bootstrap();
