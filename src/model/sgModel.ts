import { Model } from "sutando";
import { inspect, InspectOptions } from "util";

class SgModel extends Model {
    table = "model";

    id!: number;

    name!: string | null;
    vendor_id!: number | null;
    vendor_model_id!: number | null;
    enable!: boolean;
    prices!: { input?: number, output?: number, cache_read?: number } | null;

    casts = {
        prices: 'json'
    };

    created_at!: Date;
    updated_at!: Date;

    [inspect.custom](depth: number, options: InspectOptions) {
        return JSON.stringify(this.toData(), null, 2);
    }
}

export { SgModel };
