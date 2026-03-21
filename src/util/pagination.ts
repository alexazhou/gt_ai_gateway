interface PaginationQuery {
    page?: string;
    pageSize?: string;
    limit?: string;
    offset?: string;
}

export interface ParsedPagination {
    page: number;
    pageSize: number;
    offset: number;
}

function parsePositiveInt(value: string | undefined): number | undefined {
    if (!value) {
        return undefined;
    }

    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed <= 0) {
        return undefined;
    }

    return parsed;
}

function parseNonNegativeInt(value: string | undefined): number | undefined {
    if (!value) {
        return undefined;
    }

    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed < 0) {
        return undefined;
    }

    return parsed;
}

export function parsePaginationQuery(
    query: PaginationQuery,
    defaultPageSize: number = 10,
): ParsedPagination {
    const page = parsePositiveInt(query.page) ?? 1;
    const pageSize = parsePositiveInt(query.pageSize)
        ?? parsePositiveInt(query.limit)
        ?? defaultPageSize;
    const offset = parseNonNegativeInt(query.offset) ?? (page - 1) * pageSize;

    return {
        page,
        pageSize,
        offset,
    };
}

export function createListResponse<T>(list: T[], total: number) {
    return {
        list,
        total,
    };
}
