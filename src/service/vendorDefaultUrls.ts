import { VendorType, ApiFormat } from "../constants";
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
function getDefaultUrl(vendorType: VendorType, format: ApiFormat): string | null {
    return defaultUrls[vendorType]?.[format] || null;
}

/**
 * Initialize the service (no-op for import approach)
 */
function loadDefaultUrls(): void {
    console.log("Vendor default URLs service initialized");
}

function getAllUrls(): VendorDefaultUrls {
    return defaultUrls as VendorDefaultUrls;
}


export default {
    loadDefaultUrls,
    getDefaultUrl,
    getAllUrls,
};