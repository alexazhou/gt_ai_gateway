import { Model } from "sutando";
import { inspect, InspectOptions } from "util";


class SgRequestActivity extends Model {
    table = "request_activity";
    // record_id 是主键，且与 record 只是逻辑关联（无外键）；created_at / updated_at 由 ORM 自动维护
    primaryKey = "record_id";

    record_id!: number;
    activities!: string;

    created_at!: Date;
    updated_at!: Date;

    [inspect.custom](depth: number, options: InspectOptions) {
        return JSON.stringify(this.toData(), null, 2);
    }
}

export { SgRequestActivity };
