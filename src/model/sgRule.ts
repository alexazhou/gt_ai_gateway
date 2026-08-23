import { Model } from "sutando";
import { inspect, InspectOptions } from "util";
import { RuleType } from "../constants";
import type { ExprNode } from "../util/rule/types";

class SgRule extends Model {
    table = "rule";

    id!: number;
    type!: RuleType;
    name!: string;
    scope!: ExprNode;
    config!: Record<string, any>;
    enabled!: boolean;
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
