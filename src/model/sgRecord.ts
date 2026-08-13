import { Model } from "sutando";
import { inspect, InspectOptions } from "util";

import { SgRecordStatus } from "../constants";


class SgRecordUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
}


class SgRecord extends Model {
    table = "record";

    casts = {
        start_at: "datetime",
        end_at: "datetime",
    };

    id!: number;

    user_id!: number | null;
    model_id!: number | null;
    vendor_id!: number | null;
    vendor_model_name!: string | null;

    request_data!: string | null;
    response_data!: string | null;
    status!: SgRecordStatus | null;
    failed_code!: string | null;
    client_format!: string | null;
    /** 上游实际使用的协议格式：null 表示与 client_format 一致（直接路由，未发生协议转换）；非 null 为网关转换后实际请求上游的格式（如 responses 回退到 openai 时记录为 "openai"） */
    upstream_format!: string | null;

    usage!: string | null;
    first_token_latency!: number | null;
    start_at!: Date | null;
    end_at!: Date | null;
    cost!: number;

    created_at!: Date;
    updated_at!: Date;

    [inspect.custom](depth: number, options: InspectOptions) {
        return JSON.stringify(this.toData(), null, 2);
    }
}

const RECORD_SUMMARY_COLUMNS = [
    "id", "user_id", "model_id", "vendor_id", "vendor_model_name",
    "status", "failed_code", "client_format", "upstream_format",
    "usage", "first_token_latency", "start_at", "end_at", "cost",
    "created_at", "updated_at"
];

export { SgRecord, SgRecordUsage, RECORD_SUMMARY_COLUMNS };
