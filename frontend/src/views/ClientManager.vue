<template>
    <div class="client-manager">
        <div class="page-header">
            <h2 class="page-title">客户端管理</h2>
            <p class="page-desc">管理和切换本地AI客户端所使用的模型配置。可以给每个客户端建立多份配置，从而方便快捷地在不同的模型服务中切换。</p>
        </div>

        <a-spin :spinning="loading">
            <a-alert
                v-if="!available"
                type="warning"
                show-icon
                message="客户端管理不可用"
                :description="unavailableReason || '请本地安装使用。'"
                class="unavailable-alert"
            />

            <div v-if="available" class="toolbar">
                <a-button :loading="loading" @click="loadStatus">
                    <ReloadOutlined />
                    重新检测
                </a-button>
            </div>

            <a-tabs v-if="available" v-model:activeKey="activeClient" class="client-tabs">
                <a-tab-pane v-for="client in clients" :key="client.client">
                    <template #tab>
                        <div class="tab-title" :class="{ 'tab-uninstalled': !client.installed }">
                            {{ client.displayName }}
                        </div>
                    </template>

                    <ClientPanel :client="client" @refresh="loadStatus" />
                </a-tab-pane>
            </a-tabs>

            <a-empty
                v-if="!loading && clients.length === 0"
                description="未检测到可配置客户端"
                class="empty-state"
            />
        </a-spin>
    </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ReloadOutlined } from '@ant-design/icons-vue';
import { getClientConfigStatus } from '@/api/clientConfig';
import { ClientName } from '@/types/clientConfig';
import type { ClientConfigStatus } from '@/types/clientConfig';
import ClientPanel from '@/components/clientConfig/ClientPanel.vue';

const loading = ref(false);
const available = ref(true);
const unavailableReason = ref('');
const clients = ref<ClientConfigStatus[]>([]);
const activeClient = ref<ClientName | ''>('');
const route = useRoute();
const router = useRouter();

watch(activeClient, (val) => {
    if (val && val !== route.params.tab) {
        router.replace({ name: 'ClientManager', params: { tab: val } });
    }
});

onMounted(() => {
    const tabParam = route.params.tab;
    if (tabParam && typeof tabParam === 'string') activeClient.value = tabParam as ClientName;
    void loadStatus();
});

async function loadStatus(): Promise<void> {
    loading.value = true;
    try {
        const response = await getClientConfigStatus();
        available.value = response.available;
        unavailableReason.value = response.reason || '';
        clients.value = response.clients;
        const firstClient = response.clients[0];
        if (!activeClient.value && firstClient) {
            const tabParam = route.params.tab;
            activeClient.value = (tabParam && typeof tabParam === 'string' ? tabParam : firstClient.client) as ClientName;
        }
    } finally {
        loading.value = false;
    }
}
</script>

<style scoped>
.client-manager {
    background: var(--bg-page);
    min-height: calc(100vh - 64px);
    padding: 24px;
    max-width: 980px;
}

.page-header {
    margin-bottom: 24px;
}

.page-title {
    margin: 0 0 4px;
    font-size: 20px;
    font-weight: 600;
    color: var(--text-primary);
}

.page-desc {
    margin: 0;
    color: var(--text-secondary, #8c8c8c);
    font-size: 14px;
}

.toolbar {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 12px;
}

.unavailable-alert {
    max-width: 720px;
}

.client-tabs {
    background: var(--bg-card, #ffffff);
    border: 1px solid var(--border-color, #f0f0f0);
    border-radius: 8px;
    padding: 0 18px 18px;
}

.tab-title {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-primary, #1a1a1a);
}

.tab-uninstalled {
    color: var(--text-secondary, #999);
}

.empty-state {
    margin: 48px 0;
}
</style>
