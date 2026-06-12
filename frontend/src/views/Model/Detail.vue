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
                <a-descriptions-item label="所属供应商 ID">
                    {{ model.vendor_id }}
                </a-descriptions-item>
                <a-descriptions-item label="状态">
                    <a-tag :color="Boolean(model.enable) ? 'green' : 'red'">
                        {{ Boolean(model.enable) ? '启用' : '禁用' }}
                    </a-tag>
                </a-descriptions-item>
                <a-descriptions-item label="供应商模型">
                    {{ vendorModel?.model_id || '-' }}
                </a-descriptions-item>
                <a-descriptions-item label="支持协议">
                    <template v-if="vendorModel?.allowed_formats?.length">
                        <a-tag v-for="fmt in vendorModel.allowed_formats" :key="fmt" color="blue">
                            {{ fmt }}
                        </a-tag>
                    </template>
                    <span v-else>-</span>
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
import { fetchVendorModelsByIds } from '@/api/vendor';
import { formatDate } from '@/utils/format';
import type { Model } from '@/types/model';
import type { VendorModel } from '@/types/vendor';

const route = useRoute();
const router = useRouter();

const loading = ref(false);
const model = ref<Model | null>(null);
const vendorModel = ref<VendorModel | null>(null);

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
        if (m.vendor_model_id) {
            const vms = await fetchVendorModelsByIds([m.vendor_model_id]);
            if (vms && vms.length > 0) {
                vendorModel.value = vms[0] ?? null;
            }
        }
    } catch (error) {
        console.error('加载模型失败:', error);
    } finally {
        loading.value = false;
    }
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
