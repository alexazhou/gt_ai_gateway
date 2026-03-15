<template>
    <a-card :loading="loading" hoverable class="status-card">
        <template #title>
            <span>{{ title }}</span>
        </template>
        <div class="status-content">
            <div class="status-value">{{ value }}</div>
            <div v-if="description" class="status-description">
                {{ description }}
            </div>
        </div>
    </a-card>
</template>

<script setup lang="ts">
interface Props {
    title: string;
    value: string | number;
    description?: string;
    loading?: boolean;
}

defineProps<Props>();
</script>

<style scoped>
.status-card {
    height: 100%;
}

.status-card :deep(.ant-card-body) {
    height: calc(100% - 57px);
    display: flex;
    align-items: center;
    justify-content: center;
}

.status-content {
    width: 100%;
    text-align: center;
}

.status-value {
    font-size: 32px;
    font-weight: bold;
    color: #1890ff;
}

.status-description {
    margin-top: 8px;
    color: #666;
}
</style>
