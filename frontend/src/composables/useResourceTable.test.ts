import { describe, expect, it, vi } from 'vitest';
import { useResourceTable } from './useResourceTable';
import type { ListResult } from '@/types';

interface Row {
    id: number;
}

interface SearchForm {
    keyword?: string;
}

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

type RowListResult = ListResult<Row>;

describe('useResourceTable', () => {
    it('ignores a stale response that resolves after a newer request', async () => {
        const requests: Array<ReturnType<typeof createDeferred<RowListResult>>> = [];
        const fetcher = vi.fn(() => {
            const deferred = createDeferred<RowListResult>();
            requests.push(deferred);
            return deferred.promise;
        });

        const table = useResourceTable<Row, SearchForm>({
            initialSearchForm: {},
            fetcher,
            resetSearchForm: (form) => {
                form.keyword = undefined;
            },
            immediate: false,
        });

        const first = table.loadData();
        table.searchForm.keyword = 'new';
        const second = table.loadData();

        // 新请求先返回
        requests[1]!.resolve({ list: [{ id: 2 }], total: 1 });
        await second;
        expect(table.data.value).toEqual([{ id: 2 }]);
        expect(table.loading.value).toBe(false);

        // 旧请求后返回，不能覆盖新结果
        requests[0]!.resolve({ list: [{ id: 1 }], total: 1 });
        await first;
        expect(table.data.value).toEqual([{ id: 2 }]);
        expect(table.loading.value).toBe(false);
    });

    it('keeps loading until the latest request settles', async () => {
        const requests: Array<ReturnType<typeof createDeferred<RowListResult>>> = [];
        const fetcher = vi.fn(() => {
            const deferred = createDeferred<RowListResult>();
            requests.push(deferred);
            return deferred.promise;
        });

        const table = useResourceTable<Row, SearchForm>({
            initialSearchForm: {},
            fetcher,
            resetSearchForm: (form) => {
                form.keyword = undefined;
            },
            immediate: false,
        });

        const first = table.loadData();
        const second = table.loadData();

        requests[0]!.resolve({ list: [{ id: 1 }], total: 1 });
        await first;
        // 旧请求结束时仍有一个新请求在途
        expect(table.loading.value).toBe(true);

        requests[1]!.resolve({ list: [{ id: 2 }], total: 1 });
        await second;
        expect(table.loading.value).toBe(false);
        expect(table.data.value).toEqual([{ id: 2 }]);
    });
});
