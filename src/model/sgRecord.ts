import { Model } from "sutando";
import { inspect, InspectOptions } from "util";

import { SgRecordStatus } from "../constants";

class SgRecord extends Model {
    table = "record";

    casts = {
        start_at: "datetime",
        end_at: "datetime",
    };

    id!: number;

    user_id!: number | null;
    model_id!: number | null;
    request_data!: string | null;
    response_data!: string | null;
    status!: SgRecordStatus | null;
    failed_code!: string | null;

    prompt_tokens!: number | null;
    output_tokens!: number | null;
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

export { SgRecord };
