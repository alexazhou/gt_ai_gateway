<template>
    <div class="user-detail">
        <a-page-header
            title="用户详情"
            @back="handleBack"
        />
        <a-card v-if="user" :loading="loading">
            <a-descriptions :column="1" bordered>
                <a-descriptions-item label="ID">{{ user.id }}</a-descriptions-item>
                <a-descriptions-item label="用户名">{{ user.name }}</a-descriptions-item>
                <a-descriptions-item label="Token">
                    <TokenDisplay :token="user.token" />
                </a-descriptions-item>
                <a-descriptions-item label="类型">
                    <a-tag :color="user.type === 'admin' ? 'red' : 'blue'">
                        {{ user.type === 'admin' ? '管理员' : '普通用户' }}
                    </a-tag>
                </a-descriptions-item>
                <a-descriptions-item label="创建时间">
                    {{ formatDate(user.created_at) }}
                </a-descriptions-item>
                <a-descriptions-item label="更新时间">
                    {{ formatDate(user.updated_at) }}
                </a-descriptions-item>
            </a-descriptions>
        </a-card>
    </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getUser } from '@/api/user';
import { formatDate } from '@/utils/format';
import TokenDisplay from '@/components/common/TokenDisplay.vue';
import type { User } from '@/types/user';

const route = useRoute();
const router = useRouter();

const loading = ref(false);
const user = ref<User | null>(null);

onMounted(async () => {
    const id = Number(route.params.id);
    if (id) {
        await loadUser(id);
    }
});

async function loadUser(id: number) {
    loading.value = true;
    try {
        user.value = await getUser(id);
    } catch (error) {
        console.error('加载用户失败:', error);
    } finally {
        loading.value = false;
    }
}

function handleBack() {
    router.push('/user');
}
</script>

<style scoped>
.user-detail {
    max-width: 800px;
}
</style>
