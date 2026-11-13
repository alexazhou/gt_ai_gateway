import { ApiFormat } from "../constants";
import defaultUrls from "../config/vendorDefaultUrls.json";

interface VendorDefaultUrls {
    [vendorType: string]: {
        [format: string]: string;
    };
}

/**
 * Get default URL for a given vendor type and format
 * @param vendorType - vendor type
 * @param format - API format
 * @returns default URL, or null if not found
 */
function getDefaultUrl(vendorType: string, format: ApiFormat): string | null {
    const urls = defaultUrls as unknown as VendorDefaultUrls;
    return urls[vendorType]?.[format] || null;
}


function getAllUrls(): VendorDefaultUrls {
    return defaultUrls as unknown as VendorDefaultUrls;
}


export default {
    getDefaultUrl,
    getAllUrls,
};
