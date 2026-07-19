import type { SgModel } from "../../model/sgModel";
import type { SgVendorModel } from "../../model/sgVendorModel";
import BaseRoutingStrategy from "./baseRoutingStrategy";

class LoadBalanceRoutingStrategy extends BaseRoutingStrategy {
    selectUpstream(
        _model: SgModel,
        vendorModels: SgVendorModel[],
    ): SgVendorModel | null {
        if (vendorModels.length === 0) {
            return null;
        }

        return vendorModels[Math.floor(Math.random() * vendorModels.length)];
    }
}

export default LoadBalanceRoutingStrategy;
