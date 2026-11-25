import { Model } from "sutando";
import { inspect, InspectOptions } from "util";
import { RuleType } from "../constants";
import type { ExprNode } from "../util/rule/types";

class SgRule extends Model {
    table = "rule";

    id!: number;
    type!: RuleType;
    name!: string;
    /** 备注：自由文本注释（最长 RULE_NOTE_MAX_LENGTH），未填为 null */
    note!: string | null;
    scope!: ExprNode;
    config!: Record<string, any>;
    enabled!: boolean;
    /** 执行优先级：0 ~ 10000 整数，越小越先执行；同优先级按 id 升序（migrate_0035 起） */
    priority!: number;
    /** 规则来源：system（高级设置联动的系统规则）/ user（管理员手建）；系统规则只读 */
    source!: string;
    /** 系统规则业务标识（如 `SYS:setting:cch_rewrite`），用户规则为 null */
    biz_id!: string | null;
    /** 归属租户（存量回填 main） */
    tenant_id!: number | null;
    /** 全局共享标记：1 = 对所有租户生效；0 = 租户私有。仅 main 租户规则可置 1 */
    cross_tenant!: boolean;

    casts = {
        scope: "json",
        config: "json",
        enabled: "boolean",
    };

    created_at!: Date;
    updated_at!: Date;

    [inspect.custom](depth: number, options: InspectOptions) {
        return JSON.stringify(this.toData(), null, 2);
    }
}

export default SgRule;
