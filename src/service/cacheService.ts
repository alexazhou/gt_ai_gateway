const store = new Map<string, unknown>();


function get<T>(key: string): T | null {
    return store.has(key) ? (store.get(key) as T) : null;
}


function set(key: string, value: unknown): void {
    store.set(key, value);
}


function del(key: string): boolean {
    return store.delete(key);
}


function has(key: string): boolean {
    return store.has(key);
}


function entries(): Array<[string, unknown]> {
    return Array.from(store.entries());
}


function clear(): void {
    store.clear();
}

export default {
    get,
    set,
    del,
    has,
    entries,
    clear,
};
