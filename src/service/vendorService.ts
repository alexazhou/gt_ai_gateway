import { SgVendor } from "../model/sgVendor";

async function getVendorByName(name: string): Promise<SgVendor | null> {
    if (name == null) {
        return null;
    }

    return await SgVendor.query().where("name", name).first();
}

export default {
    getVendorByName,
};
