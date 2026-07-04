import { SgVendor } from "../model/sgVendor";
import { ApiFormat, VendorAuthMode } from "../constants";


async function getVendorByName(name: string): Promise<SgVendor | null> {
    if (name == null) {
        return null;
    }

    return await SgVendor.query().where("name", name).first();
}


async function updateVendor(
    vendorId: number,
    data: { type?: string; name?: string; token?: string; urls?: Record<string, string>; config?: Record<string, any> },
): Promise<SgVendor | null> {
    const vendor = await SgVendor.query().find(vendorId);

    if (!vendor) {
        return null;
    }

    const updateData: any = {
        type: data.type ?? vendor.type,
        name: data.name ?? vendor.name,
        token: data.token ?? vendor.token,
    };

    // Handle urls - if provided, serialize as JSON string
    if (data.urls !== undefined) {
        updateData.urls = JSON.stringify(data.urls);
    }

    // Handle config - if provided, serialize as JSON string
    if (data.config !== undefined) {
        updateData.config = JSON.stringify(data.config);
    }

    await SgVendor.query()
        .where("id", vendorId)
        .update(updateData);

    return await SgVendor.query().find(vendorId);
}

async function findVendorByUrl(gatewayUrl: string, protocol: ApiFormat): Promise<number | null> {
    if (!gatewayUrl) return null;

    const vendors = await SgVendor.query().get();
    for (const vendor of vendors) {
        const mergedUrls = vendor.getMergedUrls();
        let vendorUrl: string | undefined;

        if (protocol === ApiFormat.RESPONSES) {
            vendorUrl = mergedUrls[ApiFormat.RESPONSES] || mergedUrls[ApiFormat.OPENAI];
        } else {
            vendorUrl = mergedUrls[protocol];
        }

        if (vendorUrl && gatewayUrl.startsWith(vendorUrl)) {
            return Number(vendor.id);
        }
    }

    return null;
}


export default {
    getVendorByName,
    updateVendor,
    findVendorByUrl,
};
