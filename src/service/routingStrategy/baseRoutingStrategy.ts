import type { ApiFormat } from "../../constants";
import type { SgModel } from "../../model/sgModel";

class ModelRoutingResult {
    constructor(
        readonly vendorId: number,
        readonly vendorModelName: string,
        readonly supportedFormats: ApiFormat[],
    ) {}
}

abstract class BaseRoutingStrategy {
    abstract selectUpstream(
        model: SgModel,
        candidates: ModelRoutingResult[],
    ): ModelRoutingResult | null;
}

export default BaseRoutingStrategy;
export { ModelRoutingResult };
