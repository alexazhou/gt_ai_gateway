import type { SgModel } from "../../model/sgModel";
import type { SgVendorModel } from "../../model/sgVendorModel";
import type { ApiFormat } from "../../constants";

interface RoutingCandidate {
    vendorModel: SgVendorModel;
    upstreamFormat: ApiFormat;
}

abstract class BaseRoutingStrategy {
    abstract selectUpstream(
        model: SgModel,
        candidates: RoutingCandidate[],
    ): RoutingCandidate | null;
}

export { RoutingCandidate };
export default BaseRoutingStrategy;
