export interface ConfigMap {
    cch_rewrite_enabled: boolean;
    [key: string]: string | boolean | number | null;
}

export interface UpdateConfigRequest {
    cch_rewrite_enabled?: boolean;
    [key: string]: string | boolean | number | null | undefined;
}
