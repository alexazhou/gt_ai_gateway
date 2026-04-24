import { reactive, ref } from 'vue';
import type { TablePaginationConfig } from 'ant-design-vue';
import type { Dayjs } from 'dayjs';
import { useRecordStore } from '@/stores/record';
import type { TablePaginationState } from '@/types';
import type { RecordQuery, RequestStatus } from '@/types/record';

export interface RecordSearchForm {
    status?: RequestStatus;
    user_ids?: number[];
    model_ids?: number[];
    start_time?: string;
    end_time?: string;
}

const DEFAULT_PAGE_SIZE = 10;

export function useRecordTable() {
    const recordStore = useRecordStore();
    const dateRange = ref<[Dayjs, Dayjs] | null>(null);

    const searchForm = reactive<RecordSearchForm>({
        status: undefined,
        user_ids: undefined,
        model_ids: undefined,
        start_time: undefined,
        end_time: undefined,
    });

    const pagination = reactive<TablePaginationState>({
        current: 1,
        pageSize: DEFAULT_PAGE_SIZE,
        total: 0,
        showSizeChanger: true,
        showQuickJumper: true,
        pageSizeOptions: ['10', '20', '50', '100'],
    });

    function buildQuery(): RecordQuery {
        return {
            page: pagination.current,
            pageSize: pagination.pageSize,
            ...searchForm,
            user_ids: searchForm.user_ids?.length ? searchForm.user_ids.join(",") : undefined,
            model_ids: searchForm.model_ids?.length ? searchForm.model_ids.join(",") : undefined,
        };
    }

    async function loadData(): Promise<void> {
        const result = await recordStore.fetchRecords(buildQuery());
        pagination.total = result.total;
    }

    function resetSearchForm(): void {
        searchForm.status = undefined;
        searchForm.user_ids = undefined;
        searchForm.model_ids = undefined;
        searchForm.start_time = undefined;
        searchForm.end_time = undefined;
    }

    function resetPagination(): void {
        pagination.current = 1;
        pagination.pageSize = DEFAULT_PAGE_SIZE;
    }

    function handleSearch(): void {
        pagination.current = 1;
        recordStore.clearRecords();
        void loadData();
    }

    function handleReset(): void {
        resetSearchForm();
        dateRange.value = null;
        resetPagination();
        recordStore.clearRecords();
        void loadData();
    }

    function handleTableChange(pag: TablePaginationConfig): void {
        pagination.current = pag.current ?? 1;
        pagination.pageSize = pag.pageSize ?? pagination.pageSize;
        void loadData();
    }

    function handleDateChange(dates: [Dayjs, Dayjs] | null): void {
        if (dates) {
            searchForm.start_time = dates[0].format('YYYY-MM-DD HH:mm:ss');
            searchForm.end_time = dates[1].format('YYYY-MM-DD HH:mm:ss');
            return;
        }

        searchForm.start_time = undefined;
        searchForm.end_time = undefined;
    }

    return {
        recordStore,
        searchForm,
        pagination,
        dateRange,
        loadData,
        handleSearch,
        handleReset,
        handleTableChange,
        handleDateChange,
    };
}
