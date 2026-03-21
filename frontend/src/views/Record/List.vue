<template>
    <div class="record-list">
        <div class="table-header">
            <div class="search-area">
                <a-form layout="inline">
                    <a-form-item label="状态">
                        <a-select
                            v-model:value="searchForm.status"
                            placeholder="全部状态"
                            style="width: 120px"
                            allow-clear
                        >
                            <a-select-option value="success">成功</a-select-option>
                            <a-select-option value="failed">失败</a-select-option>
                            <a-select-option value="processing">处理中</a-select-option>
                            <a-select-option value="init">初始化</a-select-option>
                        </a-select>
                    </a-form-item>
                    <a-form-item label="用户">
                        <a-input
                            v-model:value="searchForm.user_name"
                            placeholder="搜索用户名"
                            allow-clear
                            style="width: 150px"
                        />
                    </a-form-item>
                    <a-form-item label="模型">
                        <a-input
                            v-model:value="searchForm.model_name"
                            placeholder="搜索模型名"
                            allow-clear
                            style="width: 150px"
                        />
                    </a-form-item>
                    <a-form-item label="时间范围">
                        <a-range-picker
                            v-model:value="dateRange"
                            :show-time="{ format: 'HH:mm' }"
                            format="YYYY-MM-DD HH:mm"
                            @change="handleDateChange"
                        />
                    </a-form-item>
                    <a-form-item>
                        <a-space>
                            <a-button type="primary" @click="handleSearch">搜索</a-button>
                            <a-button @click="handleReset">重置</a-button>
                        </a-space>
                    </a-form-item>
                </a-form>
            </div>
            <div class="action-area">
                <a-space>
                    <a-tooltip title="自动刷新">
                        <a-switch
                            v-model:checked="autoRefreshEnabled"
                            checked-children="开"
                            un-checked-children="关"
                            @change="handleAutoRefreshChange"
                        />
                    </a-tooltip>
                    <span class="refresh-hint">
                        自动刷新
                        <template v-if="autoRefreshEnabled">
                            ({{ remainingSeconds }} 秒后刷新)
                        </template>
                    </span>
                </a-space>
            </div>
        </div>

        <RecordTable
            :records="recordStore.records"
            :loading="recordStore.loading"
            :pagination="pagination"
            @change="handleTableChange"
        />
    </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, reactive } from 'vue';
import type { TablePaginationConfig } from 'ant-design-vue';
import { useRecordStore } from '@/stores/record';
import { useAutoRefresh } from '@/composables/useAutoRefresh';
import type { TablePaginationState } from '@/types';
import type { RecordQuery, RequestStatus } from '@/types/record';
import type { Dayjs } from 'dayjs';
import RecordTable from '@/components/common/RecordTable.vue';

const recordStore = useRecordStore();

const autoRefreshEnabled = ref(false);
const dateRange = ref<[Dayjs, Dayjs] | null>(null);

const searchForm = reactive<{
    status?: RequestStatus;
    user_name?: string;
    model_name?: string;
    start_time?: string;
    end_time?: string;
}>({});

const pagination = reactive<TablePaginationState>({
    current: 1,
    pageSize: 10,
    total: 0,
    showSizeChanger: true,
    showQuickJumper: true,
    pageSizeOptions: ['10', '20', '50', '100'],
});

const {
    start: startAutoRefresh,
    stop: stopAutoRefresh,
    remainingSeconds,
} = useAutoRefresh({
    callback: () => {
        loadData();
    },
    defaultInterval: 30000,
    immediate: false,
});

onMounted(() => {
    loadData();
});

onUnmounted(() => {
    stopAutoRefresh();
});

async function loadData() {
    const query: RecordQuery = {
        page: pagination.current,
        pageSize: pagination.pageSize,
        ...searchForm,
    };

    await recordStore.fetchRecords(query);
    pagination.total = recordStore.total;
}

function handleSearch() {
    pagination.current = 1;
    recordStore.clearRecords();
    loadData();
}

function handleReset() {
    searchForm.status = undefined;
    searchForm.user_name = undefined;
    searchForm.model_name = undefined;
    searchForm.start_time = undefined;
    searchForm.end_time = undefined;
    dateRange.value = null;
    pagination.current = 1;
    pagination.pageSize = 10;
    recordStore.clearRecords();
    loadData();
}

function handleTableChange(pag: TablePaginationConfig) {
    pagination.current = pag.current ?? 1;
    pagination.pageSize = pag.pageSize ?? pagination.pageSize;
    loadData();
}

function handleDateChange(dates: [Dayjs, Dayjs] | null) {
    if (dates) {
        searchForm.start_time = dates[0].format('YYYY-MM-DD HH:mm:ss');
        searchForm.end_time = dates[1].format('YYYY-MM-DD HH:mm:ss');
    } else {
        searchForm.start_time = undefined;
        searchForm.end_time = undefined;
    }
}

function handleAutoRefreshChange(checked: boolean) {
    if (checked) {
        startAutoRefresh();
    } else {
        stopAutoRefresh();
    }
}
</script>

<style scoped>
.record-list {
    background: var(--bg-page);
    padding: 24px;
}

.table-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 16px;
    flex-wrap: wrap;
    gap: 16px;
}

.search-area {
    flex: 1;
    min-width: 0;
}

.search-area :deep(.ant-form-item) {
    margin-bottom: 12px;
    margin-right: 16px;
}

/* 最后一个 item 不需要右边距 */
.search-area :deep(.ant-form-item:last-child) {
    margin-right: 0;
}

.action-area {
    flex-shrink: 0;
    padding-top: 4px;
}

.refresh-hint {
    font-size: 12px;
    color: var(--text-secondary);
}
</style>
