import type { SgModel } from "../../model/sgModel";
import type { SgVendorModel } from "../../model/sgVendorModel";
import BaseRoutingStrategy from "./baseRoutingStrategy";

class FailoverRoutingStrategy extends BaseRoutingStrategy {
    selectUpstream(
        _model: SgModel,
        vendorModels: SgVendorModel[],
    ): SgVendorModel | null {
        return vendorModels[0] ?? null;
    }
}

export default FailoverRoutingStrategy;
