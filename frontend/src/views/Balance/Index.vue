<template>
    <div class="balance-page">
        <a-tabs v-model:active-key="activeTab">
            <a-tab-pane key="users" tab="用户余额">
                <UserBalanceTable @adjust="handleAdjust" />
            </a-tab-pane>
            <a-tab-pane key="records" tab="充值记录">
                <RechargeRecordsTable :selected-user-id="selectedUserId" />
            </a-tab-pane>
        </a-tabs>
        <BalanceAdjustDialog ref="adjustDialogRef" @success="handleAdjustSuccess" />
    </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import type { User } from '@/types/user';
import UserBalanceTable from './components/UserBalanceTable.vue';
import RechargeRecordsTable from './components/RechargeRecordsTable.vue';
import BalanceAdjustDialog from './components/BalanceAdjustDialog.vue';

const activeTab = ref('users');
const selectedUserId = ref<number | undefined>();
const adjustDialogRef = ref();

function handleAdjust(user: User) {
    selectedUserId.value = user.id;
    adjustDialogRef.value?.open(user);
}

function handleAdjustSuccess() {
    // 刷新数据
}
</script>

<style scoped>
.balance-page {
    background: var(--bg-page);
    padding: 24px;
    min-height: calc(100vh - 64px);
}
</style>
