import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useRecordTable } from './useRecordTable';

const fetchRecords = vi.fn();
const clearRecords = vi.fn();

vi.mock('@/stores/record', () => ({
    useRecordStore: () => ({
        fetchRecords,
        clearRecords,
    }),
}));

describe('useRecordTable', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        fetchRecords.mockReset();
        clearRecords.mockReset();
        fetchRecords.mockResolvedValue({ total: 42 });
    });

    it('builds record queries from form and pagination state', async () => {
        const recordTable = useRecordTable();

        recordTable.searchForm.status = 'success';
        recordTable.searchForm.user_name = 'alice';
        recordTable.searchForm.model_name = 'gpt-4';
        recordTable.pagination.current = 3;
        recordTable.pagination.pageSize = 20;

        await recordTable.loadData();

        expect(fetchRecords).toHaveBeenCalledWith({
            page: 3,
            pageSize: 20,
            status: 'success',
            user_name: 'alice',
            model_name: 'gpt-4',
            start_time: undefined,
            end_time: undefined,
        });
        expect(recordTable.pagination.total).toBe(42);
    });

    it('resets filters and pagination before reloading data', () => {
        const recordTable = useRecordTable();

        recordTable.searchForm.status = 'failed';
        recordTable.searchForm.user_name = 'bob';
        recordTable.searchForm.model_name = 'test-model';
        recordTable.searchForm.start_time = '2026-03-21 10:00:00';
        recordTable.searchForm.end_time = '2026-03-21 11:00:00';
        recordTable.pagination.current = 4;
        recordTable.pagination.pageSize = 50;

        recordTable.handleReset();

        expect(recordTable.searchForm.status).toBeUndefined();
        expect(recordTable.searchForm.user_name).toBeUndefined();
        expect(recordTable.searchForm.model_name).toBeUndefined();
        expect(recordTable.searchForm.start_time).toBeUndefined();
        expect(recordTable.searchForm.end_time).toBeUndefined();
        expect(recordTable.pagination.current).toBe(1);
        expect(recordTable.pagination.pageSize).toBe(10);
        expect(recordTable.dateRange.value).toBeNull();
        expect(clearRecords).toHaveBeenCalledTimes(1);
        expect(fetchRecords).toHaveBeenCalledWith({
            page: 1,
            pageSize: 10,
            status: undefined,
            user_name: undefined,
            model_name: undefined,
            start_time: undefined,
            end_time: undefined,
        });
    });
});
