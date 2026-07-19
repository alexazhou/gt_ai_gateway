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
                <a-descriptions-item label="上游模型">
                    <a-space direction="vertical">
                        <span
                            v-for="(upstream, index) in model.routing_config.upstreams"
                            :key="`${upstream.vendor_id}-${upstream.vendor_model_id ?? 'auto'}-${index}`"
                        >
                            <a-tag :color="upstream.enabled ? 'blue' : 'default'">
                                {{ getVendorName(upstream.vendor_id) }}
                            </a-tag>
                            {{ getUpstreamModelName(upstream.vendor_model_id) }}
                            <a-tag v-if="!upstream.enabled">禁用</a-tag>
                        </span>
                    </a-space>
                </a-descriptions-item>
                <a-descriptions-item label="价格">
                    输入: ¥{{ (model.prices?.input || 0).toFixed(6) }} / 千tokens<br/>
                    输出: ¥{{ (model.prices?.output || 0).toFixed(6) }} / 千tokens<br/>
                    缓存读取: ¥{{ (model.prices?.cache_read || 0).toFixed(6) }} / 千tokens
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
import { fetchVendorModelsByIds, fetchVendorsByIds } from '@/api/vendor';
import { formatDate } from '@/utils/format';
import type { Model, ModelRoutingMode } from '@/types/model';
import type { Vendor, VendorModel } from '@/types/vendor';

const route = useRoute();
const router = useRouter();

const loading = ref(false);
const model = ref<Model | null>(null);
const vendorMap = ref<Map<number, Vendor>>(new Map());
const vendorModelMap = ref<Map<number, VendorModel>>(new Map());

onMounted(async () => {
    const id = Number(route.params.id);
    if (id) {
        await loadModel(id);
    }
});

async function loadModel(id: number) {
    loading.value = true;
    try {
        const m = await getModel(id);
        model.value = m;
        const vendorIds = [...new Set(m.routing_config.upstreams.map(upstream => upstream.vendor_id))];
        const vendorModelIds = [...new Set(m.routing_config.upstreams
            .map(upstream => upstream.vendor_model_id)
            .filter((vendorModelId): vendorModelId is number => vendorModelId != null))];
        const [vendors, vendorModels] = await Promise.all([
            fetchVendorsByIds(vendorIds),
            vendorModelIds.length > 0 ? fetchVendorModelsByIds(vendorModelIds) : [],
        ]);
        vendorMap.value = new Map(vendors.map(vendor => [vendor.id, vendor]));
        vendorModelMap.value = new Map(vendorModels.map(vendorModel => [vendorModel.id, vendorModel]));
    } catch (error) {
        console.error('加载模型失败:', error);
    } finally {
        loading.value = false;
    }
}

function getRoutingModeName(mode: ModelRoutingMode): string {
    return {
        single: '单上游',
        load_balance: '负载均衡',
        failover: '故障转移',
    }[mode];
}

function getVendorName(vendorId: number): string {
    return vendorMap.value.get(vendorId)?.name ?? `ID: ${vendorId}`;
}

function getUpstreamModelName(vendorModelId?: number): string {
    if (!vendorModelId) {
        return `自动（${model.value?.name ?? ''}）`;
    }
    return vendorModelMap.value.get(vendorModelId)?.model_id ?? `#${vendorModelId}`;
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
