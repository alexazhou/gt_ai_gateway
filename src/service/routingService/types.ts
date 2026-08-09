import type { ApiFormat } from "../../constants";
import type { SgVendor } from "../../model/sgVendor";

class ModelRoutingResult {
    constructor(
        readonly vendor: SgVendor | null,
        readonly vendorModelName: string | null,
        readonly supportedFormats: ApiFormat[],
    ) {}

    static none(): ModelRoutingResult {
        return new ModelRoutingResult(null, null, []);
    }

    hasUpstream(): this is ModelRoutingResult & {
        vendor: SgVendor;
        vendorModelName: string;
    } {
        return this.vendor != null && this.vendorModelName != null;
    }
}

export { ModelRoutingResult };
