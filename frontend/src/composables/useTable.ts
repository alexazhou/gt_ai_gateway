import { ref, reactive } from 'vue';

export function useTable<T>(defaultPageSize: number = 10) {
    const loading = ref(false);
    const data = ref<T[]>([]);
    const total = ref(0);

    const pagination = reactive({
        current: 1,
        pageSize: defaultPageSize,
        total: 0,
        showSizeChanger: true,
        showQuickJumper: true,
        pageSizeOptions: ['10', '20', '50', '100'],
    });

    const searchForm = reactive<Record<string, any>>({});

    function setPage(page: number, pageSize?: number) {
        pagination.current = page;
        if (pageSize) {
            pagination.pageSize = pageSize;
        }
    }

    function resetSearch() {
        Object.keys(searchForm).forEach(key => {
            searchForm[key] = undefined;
        });
        pagination.current = 1;
    }

    return {
        loading,
        data,
        total,
        pagination,
        searchForm,
        setPage,
        resetSearch,
    };
}
