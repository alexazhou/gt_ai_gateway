import { Model } from "sutando";
import { CastsAttributes } from "sutando";
import { inspect, InspectOptions } from "util";

import { SgRecordStatus } from "../constants";
import { MicroAmountCast } from "../util/protocol/billingUtil";


/**
 * 请求记录的 usage 对象，同时作为 Sutando 自定义 cast（Sutando 通过 instanceof CastsAttributes 识别）。
 * 存储/读写在类内外一致：DB 列为 TEXT JSON 串，模型层按类读写。
 *
 * 口径约定（prompt_tokens 按 OpenAI 原生语义 = 输入总量含缓存命中）：
 * - 存储层带版本号 usage_version：v1（存量）prompt_tokens 为非缓存数；v2（新写入）prompt_tokens 为总量。
 * - 构造时按版本完成「存储 → 展示」转换，实例内部恒为展示口径（prompt_tokens = 非缓存输入）；
 *   toJSON() 直接输出内部字段，不再做版本判断。
 * - 各 token 字段区分「缺失」与「0」：上游未返回 → null；明确返回 0 → 0。
 */
// @ts-expect-error Sutando .d.ts 声明 static get/set() 无参，运行时传 4 个实参
class SgRecordUsage extends CastsAttributes {
    /** usage 存储版本：1 = 旧口径（prompt_tokens 非缓存）；2 = OpenAI 口径（prompt_tokens 含缓存总量） */
    version: number = 1;

    /** 输入 token（展示口径 = 非缓存输入）；上游未返回为 null，明确为 0 则为 0 */
    prompt_tokens?: number | null;

    /** 输出 token；上游未返回为 null */
    completion_tokens?: number | null;

    /** 命中缓存的输入（prompt_tokens 的子集）；上游未返回为 null */
    cache_read_tokens?: number | null;

    /** 写入缓存 token（仅记录，不参与计费）；上游未返回为 null */
    cache_creation_tokens?: number | null;

    /**
     * 构造时按存储版本完成「存储 → 展示」口径转换：
     * - v2：存储的 prompt_tokens 为总量（含缓存），转成内部统一展示口径（非缓存输入）；
     * - v1：存储的 prompt_tokens 本就是非缓存，原样保留。
     * 转换后字段恒为展示口径，toJSON() 直接输出。
     */
    constructor(data?: Partial<SgRecordUsage>) {
        super();
        if (data) {
            this.version = data.version ?? 1;
            if (this.version >= 2 && data.prompt_tokens != null) {
                this.prompt_tokens = data.cache_read_tokens != null
                    ? Math.max(0, data.prompt_tokens - data.cache_read_tokens)
                    : data.prompt_tokens;
            } else {
                this.prompt_tokens = data.prompt_tokens ?? null;
            }
            this.completion_tokens = data.completion_tokens ?? null;
            this.cache_read_tokens = data.cache_read_tokens ?? null;
            this.cache_creation_tokens = data.cache_creation_tokens ?? null;
        }
    }

    /** API 展示口径：直接输出内部字段（构造时已按版本归一化）；缺失值输出 null（JSON.stringify 自动调用） */
    toJSON(): Record<string, number | null> {
        const result: Record<string, number | null> = {
            prompt_tokens: this.prompt_tokens ?? null,
            completion_tokens: this.completion_tokens ?? null,
            cache_read_tokens: this.cache_read_tokens ?? null,
        };
        if (this.cache_creation_tokens != null) {
            result.cache_creation_tokens = this.cache_creation_tokens;
        }
        return result;
    }

    /**
     * 存储口径（v2：prompt_tokens 为总量 + usage_version 标记），供 static set() 与写侧序列化复用。
     * 从展示口径反向还原：prompt_total = 非缓存输入 + 缓存读取；cache_creation 仅在存在时输出。
     */
    toStorageJSON(): Record<string, number | null | undefined> {
        const result: Record<string, number | null | undefined> = {
            usage_version: 2,
            prompt_tokens: this.prompt_tokens != null ? this.prompt_tokens + (this.cache_read_tokens ?? 0) : null,
            completion_tokens: this.completion_tokens,
            cache_read_tokens: this.cache_read_tokens,
        };
        if (this.cache_creation_tokens != null) {
            result.cache_creation_tokens = this.cache_creation_tokens;
        }
        return result;
    }

    // ---- Sutando custom cast ----

    /** DB 串 → SgRecordUsage 实例；无版本标记的存量记录视为 v1 */
    static get(self: SgRecord, key: string, value: string | null): SgRecordUsage | null {
        if (value == null || value === "") {
            return null;
        }
        let parsed: Record<string, any>;
        try {
            parsed = JSON.parse(value);
        } catch {
            return null;
        }
        return new SgRecordUsage({ ...parsed, version: parsed.usage_version === 2 ? 2 : 1 });
    }

    // 创建时收到纯对象，读改保存时收到 SgRecordUsage 实例，两者都需支持
    static set(self: SgRecord, key: string, value: SgRecordUsage | Record<string, any> | null): string | null {
        if (value == null) {
            return null;
        }
        return JSON.stringify(value instanceof SgRecordUsage ? value.toStorageJSON() : value);
    }
}


class SgRecord extends Model {
    table = "record";

    casts = {
        start_at: "datetime",
        end_at: "datetime",
        // MySQL 下以整数微元存储（应用层仍以"元"读写），避免 DECIMAL 返回字符串
        cost: MicroAmountCast,
        usage: SgRecordUsage,
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

    /** usage 按类读写（DB 为 TEXT JSON 串，cast 负责转换）；展示口径见 SgRecordUsage.toJSON */
    usage!: SgRecordUsage | null;
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
