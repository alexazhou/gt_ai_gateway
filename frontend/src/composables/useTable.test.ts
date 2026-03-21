import { describe, expect, it } from 'vitest';
import { useTable } from './useTable';

describe('useTable', () => {
    it('updates page and page size', () => {
        const { pagination, setPage } = useTable<number>(10);

        setPage(3, 20);

        expect(pagination.current).toBe(3);
        expect(pagination.pageSize).toBe(20);
    });

    it('clears search state and pagination data', () => {
        const { data, pagination, searchForm, clearData, resetSearch } = useTable<number>(10);

        data.value = [1, 2, 3];
        pagination.total = 3;
        pagination.current = 2;
        searchForm.keyword = 'demo';

        resetSearch();
        clearData();

        expect(searchForm.keyword).toBeUndefined();
        expect(pagination.current).toBe(1);
        expect(data.value).toEqual([]);
        expect(pagination.total).toBe(0);
    });
});
