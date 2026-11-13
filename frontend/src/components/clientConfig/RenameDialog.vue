<template>
    <a-modal
        v-model:open="visible"
        title="修改配置名称"
        :confirm-loading="loading"
        ok-text="保存"
        cancel-text="取消"
        width="420px"
        @ok="handleSubmit"
    >
        <a-form layout="vertical">
            <a-form-item label="名称" required>
                <a-input v-model:value="formState.name" />
            </a-form-item>
        </a-form>
    </a-modal>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import { message } from 'ant-design-vue/es';
import { renameClientConfigBackup } from '@/api/clientConfig';
import type { ClientConfigBackupInfo, ClientName } from '@/types/clientConfig';

const props = defineProps<{
    client: ClientName;
    backupId: number;
    initialName: string;
}>();

const visible = defineModel<boolean>('open', { default: false });
const emit = defineEmits<{
    (e: 'renamed', backup: ClientConfigBackupInfo): void;
}>();

const loading = ref(false);

const formState = reactive({
    name: '',
});

watch(() => props.initialName, (name) => {
    formState.name = name;
}, { immediate: true });

async function handleSubmit(): Promise<void> {
    const name = formState.name.trim();
    if (!name) {
        message.error('请输入配置名称');
        return;
    }

    loading.value = true;
    try {
        const backup = await renameClientConfigBackup({
            client: props.client,
            backupId: props.backupId,
            name,
        });
        emit('renamed', backup);
        visible.value = false;
        message.success('配置名称已修改');
    } finally {
        loading.value = false;
    }
}
</script>
