import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { sendApiTest } from '@/api/gateway';
import type { ApiTestRequest, ApiTestHistory, ApiTestState } from '@/types/gateway';
import { toAppRequestError } from '@/utils/requestError';

const MAX_HISTORY_COUNT = 50;
const HISTORY_STORAGE_KEY = 'api_test_history';

export const useApiTestStore = defineStore('apiTest', () => {
    // State
    const loading = ref(false);
    const responseText = ref('');
    const error = ref<string | null>(null);
    const history = ref<ApiTestHistory[]>([]);

    // 当前配置状态
    const config = ref<ApiTestState>({
        format: 'openai',
        model: '',
        messages: [{ role: 'user', content: '' }],
        temperature: 0.7,
        max_tokens: 2048,
        stream: true,
    });

    // Getters
    const hasHistory = computed(() => history.value.length > 0);

    const canSend = computed(() => {
        return config.value.model &&
            config.value.messages.some(m => m.content.trim());
    });

    // Actions
    function loadHistory(): void {
        try {
            const stored = localStorage.getItem(HISTORY_STORAGE_KEY);
            if (stored) {
                history.value = JSON.parse(stored);
            }
        } catch {
            history.value = [];
        }
    }

    function saveHistory(): void {
        try {
            localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history.value));
        } catch {
            // 忽略存储错误
        }
    }

    async function sendRequest(
        data: ApiTestRequest,
        onChunk?: (content: string) => void,
    ): Promise<void> {
        loading.value = true;
        error.value = null;
        responseText.value = '';

        const historyItem: ApiTestHistory = {
            id: Date.now().toString(),
            timestamp: Date.now(),
            request: { ...data },
            response: '',
            status: 'pending',
        };

        try {
            await sendApiTest(data, {
                onMessage: (content: string) => {
                    responseText.value = content;
                    onChunk?.(content);
                    historyItem.response = content;
                },
                onComplete: () => {
                    loading.value = false;
                    historyItem.status = 'success';
                    addToHistory(historyItem);
                },
                onError: (err: string) => {
                    loading.value = false;
                    error.value = err;
                    responseText.value = `Error: ${err}`;
                    historyItem.status = 'error';
                    historyItem.response = err;
                    addToHistory(historyItem);
                },
            });
        } catch (err) {
            loading.value = false;
            const errorMsg = toAppRequestError(err).message;
            error.value = errorMsg;
            historyItem.status = 'error';
            historyItem.response = errorMsg;
            addToHistory(historyItem);
        }
    }

    function addToHistory(item: ApiTestHistory): void {
        history.value.unshift(item);
        if (history.value.length > MAX_HISTORY_COUNT) {
            history.value = history.value.slice(0, MAX_HISTORY_COUNT);
        }
        saveHistory();
    }

    function clearHistory(): void {
        history.value = [];
        saveHistory();
    }

    function removeHistoryItem(id: string): void {
        const index = history.value.findIndex(item => item.id === id);
        if (index > -1) {
            history.value.splice(index, 1);
            saveHistory();
        }
    }

    function loadHistoryItem(item: ApiTestHistory): ApiTestRequest {
        return { ...item.request };
    }

    function clearResponse(): void {
        responseText.value = '';
        error.value = null;
    }

    function updateConfig(newConfig: Partial<ApiTestState>): void {
        config.value = { ...config.value, ...newConfig };
    }

    // 初始化时加载历史记录
    loadHistory();

    return {
        loading,
        responseText,
        error,
        history,
        config,
        hasHistory,
        canSend,
        sendRequest,
        clearHistory,
        removeHistoryItem,
        loadHistoryItem,
        clearResponse,
        updateConfig,
        loadHistory,
    };
});
