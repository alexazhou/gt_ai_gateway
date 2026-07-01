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
                    <a-tag :color="getTypeColor(vendor.type)" :style="getTypeTagStyle(vendor.type)">
                        {{ getTypeLabel(vendor.type) }}
                    </a-tag>
                </a-descriptions-item>
                <a-descriptions-item label="名称">{{ vendor.name }}</a-descriptions-item>
                <a-descriptions-item label="Token">
                    <TokenDisplay :token="vendor.token" />
                </a-descriptions-item>
                <a-descriptions-item v-if="vendor.type === 'anthropic'" label="认证方式">
                    <a-tag :color="vendor.auth_mode === 'bearer_token' ? 'blue' : 'green'">
                        {{ vendor.auth_mode === 'bearer_token' ? 'Bearer Token (Authorization)' : 'API Key (x-api-key)' }}
                    </a-tag>
                </a-descriptions-item>
                <a-descriptions-item label="URLs">
                    <div v-for="item in getMergedUrls(vendor)" :key="item.key" class="url-item">
                        <strong>{{ item.key }}:</strong> {{ item.url }}
                        <a-tag v-if="item.isCustom" color="blue" style="margin-left: 6px; font-size: 11px;">自定义</a-tag>
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
import { useVendorPresets } from '@/composables/useVendorPresets';

const route = useRoute();
const router = useRouter();
const { presetUrls, load: loadPresets } = useVendorPresets();

const loading = ref(false);
const vendor = ref<Vendor | null>(null);

onMounted(async () => {
    const id = Number(route.params.id);
    if (id) {
        void loadPresets();
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

function getMergedUrls(v: Vendor): { key: string; url: string; isCustom: boolean }[] {
    const preset = presetUrls.value[v.type] ?? {};
    const custom = v.urls ?? {};
    const keys = new Set([...Object.keys(preset), ...Object.keys(custom)]);
    return [...keys].map(key => ({
        key,
        url: custom[key] ?? preset[key] ?? '',
        isCustom: !!custom[key],
    }));
}

function getTypeLabel(type: VendorType): string {
    const labels: Record<VendorType, string> = {
        aliyun: 'Aliyun (通义千问)',
        aliyun_coding: 'Aliyun Coding',
        volcengine_coding: 'Volcengine Coding',
        deepseek: 'DeepSeek',
        mimo: 'Mimo',
        mimo_token_plan: 'Mimo Token Plan',
        opencode_go: 'OpenCode Go',
        openai: 'OpenAI',
        anthropic: 'Anthropic',
        google: 'Google',
        other: 'Other',
    };
    return labels[type] || type;
}

function getTypeColor(type: VendorType): string {
    const colors: Record<VendorType, string> = {
        aliyun: 'orange',
        aliyun_coding: 'orange',
        volcengine_coding: 'purple',
        deepseek: '',
        mimo: 'blue',
        mimo_token_plan: 'blue',
        opencode_go: 'cyan',
        openai: 'green',
        anthropic: 'orange',
        google: '',
        other: 'default',
    };
    return colors[type] || 'default';
}

function getTypeTagStyle(type: VendorType) {
    if (type === 'deepseek' || type === 'google') {
        return {
            color: 'var(--accent-primary)',
            backgroundColor: 'var(--accent-primary-soft)',
            borderColor: 'var(--accent-primary-border)',
        };
    }
    return undefined;
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
