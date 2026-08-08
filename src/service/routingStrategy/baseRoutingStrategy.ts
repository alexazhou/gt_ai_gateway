import type { ApiFormat } from "../../constants";
import type { SgModel } from "../../model/sgModel";
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
}

abstract class BaseRoutingStrategy {
    abstract selectUpstream(
        model: SgModel,
        candidates: ModelRoutingResult[],
    ): ModelRoutingResult;
}

export default BaseRoutingStrategy;
export { ModelRoutingResult };
