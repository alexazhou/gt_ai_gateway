import { Model } from "sutando";
import { inspect, InspectOptions } from "util";

class SgConfig extends Model {
    table = "config";

    id!: number;
    name!: string;
    value!: string;

    created_at!: Date;
    updated_at!: Date;

    [inspect.custom](depth: number, options: InspectOptions) {
        return JSON.stringify(this.toData(), null, 2);
    }
}

export { SgConfig };
