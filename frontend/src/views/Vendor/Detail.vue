<template>
    <div class="vendor-detail">
        <a-page-header
            title="供应商详情"
            @back="handleBack"
        />
        <a-card v-if="vendor" :loading="loading">
            <a-descriptions :column="1" bordered>
                <a-descriptions-item label="ID">{{ vendor.id }}</a-descriptions-item>
                <a-descriptions-item label="类型">
                    <a-tag :color="getTypeColor(vendor.type)">
                        {{ getTypeLabel(vendor.type) }}
                    </a-tag>
                </a-descriptions-item>
                <a-descriptions-item label="名称">{{ vendor.name }}</a-descriptions-item>
                <a-descriptions-item label="Token">
                    <TokenDisplay :token="vendor.token" />
                </a-descriptions-item>
                <a-descriptions-item label="URLs">
                    <div v-for="(url, key) in vendor.urls" :key="key" class="url-item">
                        <strong>{{ key }}:</strong> {{ url }}
                    </div>
                </a-descriptions-item>
                <a-descriptions-item label="创建时间">
                    {{ formatDate(vendor.created_at) }}
                </a-descriptions-item>
                <a-descriptions-item label="更新时间">
                    {{ formatDate(vendor.updated_at) }}
                </a-descriptions-item>
            </a-descriptions>
        </a-card>
    </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getVendor } from '@/api/vendor';
import { formatDate } from '@/utils/format';
import TokenDisplay from '@/components/common/TokenDisplay.vue';
import type { Vendor, VendorType } from '@/types/vendor';

const route = useRoute();
const router = useRouter();

const loading = ref(false);
const vendor = ref<Vendor | null>(null);

onMounted(async () => {
    const id = Number(route.params.id);
    if (id) {
        await loadVendor(id);
    }
});

async function loadVendor(id: number) {
    loading.value = true;
    try {
        vendor.value = await getVendor(id);
    } catch (error) {
        console.error('加载供应商失败:', error);
    } finally {
        loading.value = false;
    }
}

function getTypeLabel(type: VendorType): string {
    const labels: Record<VendorType, string> = {
        openai: 'OpenAI',
        anthropic: 'Anthropic',
        google: 'Google',
    };
    return labels[type] || type;
}

function getTypeColor(type: VendorType): string {
    const colors: Record<VendorType, string> = {
        openai: 'green',
        anthropic: 'orange',
        google: 'blue',
    };
    return colors[type] || 'default';
}

function handleBack() {
    router.push('/vendor');
}
</script>

<style scoped>
.vendor-detail {
    max-width: 800px;
}

.url-item {
    margin-bottom: 8px;
}
</style>
