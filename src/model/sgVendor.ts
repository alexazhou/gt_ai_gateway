import { Model } from "sutando";
import { inspect, InspectOptions } from "util";
import { VendorType, ApiFormat } from "../constants";

class SgVendor extends Model {
    table = "vendor";

    id!: number;
    type!: VendorType;
    api_format!: ApiFormat;
    name!: string;
    token!: string;
    url!: string;

    created_at!: Date;
    updated_at!: Date;

    [inspect.custom](depth: number, options: InspectOptions) {
        return JSON.stringify(this.toData(), null, 2);
    }
}

export { SgVendor };
