import { Model } from "sutando";
import { inspect, InspectOptions } from "util";

import { SgRecordStatus } from "../constants";

class SgRecord extends Model {
    table = "record";

    id!: number;

    user_id!: number | null;
    model_id!: number | null;
    request_data!: string | null;
    response_data!: string | null;
    status!: SgRecordStatus | null;

    created_at!: Date;
    updated_at!: Date;

    [inspect.custom](depth: number, options: InspectOptions) {
        return JSON.stringify(this.toData(), null, 2);
    }
}

export { SgRecord };
