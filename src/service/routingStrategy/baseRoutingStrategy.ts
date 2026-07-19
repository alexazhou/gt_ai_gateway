import type { SgModel } from "../../model/sgModel";
import type { SgVendorModel } from "../../model/sgVendorModel";

abstract class BaseRoutingStrategy {
    abstract selectUpstream(
        model: SgModel,
        vendorModels: SgVendorModel[],
    ): SgVendorModel | null;
}

export default BaseRoutingStrategy;
