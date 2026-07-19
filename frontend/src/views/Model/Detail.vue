<template>
    <div class="model-detail">
        <a-page-header
            title="模型详情"
            @back="handleBack"
        />
        <a-card v-if="model" :loading="loading">
            <a-descriptions :column="1" bordered>
                <a-descriptions-item label="ID">{{ model.id }}</a-descriptions-item>
                <a-descriptions-item label="模型名称">{{ model.name }}</a-descriptions-item>
                <a-descriptions-item label="路由模式">
                    {{ getRoutingModeName(model.routing_mode) }}
                </a-descriptions-item>
                <a-descriptions-item label="状态">
                    <a-tag :color="Boolean(model.enable) ? 'green' : 'red'">
                        {{ Boolean(model.enable) ? '启用' : '禁用' }}
                    </a-tag>
                </a-descriptions-item>
                <a-descriptions-item label="上游配置">
                    <UpstreamConfig
                        mode="view"
                        :routing-mode="model.routing_mode"
                        :model-name="model.name"
                        :upstreams="model.routing_config.upstreams"
                    />
                </a-descriptions-item>
                <a-descriptions-item label="价格">
                    <PriceConfig mode="view" :prices="model.prices ?? {}" />
                </a-descriptions-item>
                <a-descriptions-item label="创建时间">
                    {{ formatDate(model.created_at) }}
                </a-descriptions-item>
                <a-descriptions-item label="更新时间">
                    {{ formatDate(model.updated_at) }}
                </a-descriptions-item>
            </a-descriptions>
        </a-card>
    </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getModel } from '@/api/model';
import { formatDate } from '@/utils/format';
import type { Model, ModelRoutingMode } from '@/types/model';
import PriceConfig from './PriceConfig.vue';
import UpstreamConfig from './UpstreamConfig.vue';

const route = useRoute();
const router = useRouter();

const loading = ref(false);
const model = ref<Model | null>(null);

onMounted(async () => {
    const id = Number(route.params.id);
    if (id) {
        await loadModel(id);
    }
});

async function loadModel(id: number) {
    loading.value = true;
    try {
        model.value = await getModel(id);
    } catch (error) {
        console.error('加载模型失败:', error);
    } finally {
        loading.value = false;
    }
}

function getRoutingModeName(mode: ModelRoutingMode): string {
    return {
        single: '固定上游',
        load_balance: '负载均衡',
        failover: '故障转移',
    }[mode];
}

function handleBack() {
    router.push('/model');
}
</script>

<style scoped>
.model-detail {
    max-width: 800px;
}
</style>
