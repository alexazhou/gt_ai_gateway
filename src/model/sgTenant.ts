import { Model } from "sutando";
import { inspect, InspectOptions } from "util";

class SgTenant extends Model {
    table = "tenant";

    id!: number;
    name!: string;
    description!: string | null;

    created_at!: Date;
    updated_at!: Date;

    [inspect.custom](depth: number, options: InspectOptions) {
        return JSON.stringify(this.toData(), null, 2);
    }
}

export default SgTenant;
