import { ref, reactive } from 'vue';
import type { TablePaginationState } from '@/types';

export function useTable<T, TSearch extends object = Record<string, unknown>>(
    defaultPageSize: number = 10,
    initialSearchForm?: TSearch,
) {
    const loading = ref(false);
    const data = ref<T[]>([]);
    const total = ref(0);

    const pagination = reactive<TablePaginationState>({
        current: 1,
        pageSize: defaultPageSize,
        total: 0,
        showSizeChanger: true,
        showQuickJumper: true,
        pageSizeOptions: ['10', '20', '50', '100'],
    });

    const searchForm = reactive<TSearch>(
        initialSearchForm ? { ...initialSearchForm } : ({} as TSearch),
    );

    function setPage(page: number, pageSize?: number) {
        pagination.current = page;
        if (pageSize) {
            pagination.pageSize = pageSize;
        }
    }

    function resetSearch() {
        Object.keys(searchForm).forEach((key) => {
            (searchForm as Record<string, unknown>)[key] = undefined;
        });
        pagination.current = 1;
    }

    function clearData() {
        data.value = [];
        total.value = 0;
        pagination.total = 0;
    }

    return {
        loading,
        data,
        total,
        pagination,
        searchForm,
        setPage,
        resetSearch,
        clearData,
    };
}
