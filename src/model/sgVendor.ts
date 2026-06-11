import { Model } from "sutando";
import { inspect, InspectOptions } from "util";
import { VendorType, ApiFormat } from "../constants";
import vendorDefaultUrls from "../service/vendorDefaultUrls";
import customError from "../util/customError";

class SgVendor extends Model {
    table = "vendor";

    id!: number;
    type!: VendorType;
    name!: string;
    token!: string;
    urls!: string;  // JSON string

    created_at!: Date;
    updated_at!: Date;

    /**
     * Parse URLs JSON string to object
     */
    getUrls(): Record<string, string> {
        try {
            return this.urls ? JSON.parse(this.urls) : {};
        } catch {
            return {};
        }
    }


    /**
     * Merge preset URLs and DB-stored custom URLs.
     * Custom URLs override presets with the same format key.
     */
    getMergedUrls(): Record<string, string> {
        const presetUrls = vendorDefaultUrls.getAllUrls()[this.type] ?? {};
        const merged = { ...presetUrls, ...this.getUrls() };
        delete merged['label'];
        return merged;
    }

    /**
     * Get URL by API format with default value handling
     * @param format - API format (openai, anthropic, google, etc.)
     * @returns URL string for the specified format
     * @throws Error if URL cannot be found or determined
     */
    getUrlByFormat(format: ApiFormat): string {
        const urls = this.getMergedUrls();
        const url = format === ApiFormat.RESPONSES
            ? urls[ApiFormat.RESPONSES] ?? urls[ApiFormat.OPENAI]
            : urls[format];

        if (!url) {
            throw new customError.AppError(`vendor does not have url for ${format} format`, 400);
        }

        // Normalize URL - Add missing paths if not present
        let finalUrl = url;
        if (format === ApiFormat.ANTHROPIC && !url.includes("/v1/messages")) {
            finalUrl = url.replace(/\/$/, "") + "/v1/messages";
        }
        
        if (format === ApiFormat.OPENAI && !url.includes("/chat/completions")) {
            finalUrl = url.replace(/\/$/, "") + "/chat/completions";
        }

        if (format === ApiFormat.RESPONSES && !url.includes("/responses")) {
            finalUrl = url.replace(/\/$/, "") + "/responses";
        }

        return finalUrl;
    }

    /**
     * Get the upstream format for protocol conversion.
     * Checks if the vendor supports the requested clientFormat natively (via custom URLs or default URLs).
     * If not, tries to find an alternative supported format (OpenAI or Anthropic) for protocol conversion.
     */
    getUpstreamFormat(clientFormat: ApiFormat): ApiFormat {
        const urls = this.getMergedUrls();

        if (urls[clientFormat]) {
            return clientFormat;
        }

        // Only OpenAI and Anthropic are supported for conversion right now
        if (clientFormat === ApiFormat.OPENAI || clientFormat === ApiFormat.ANTHROPIC) {
            const supportedAlternativeFormats: ApiFormat[] = [ApiFormat.OPENAI, ApiFormat.ANTHROPIC];

            for (const fmt of supportedAlternativeFormats) {
                if (urls[fmt]) return fmt;
            }
        }

        // If no format can be determined, or format doesn't support conversion, just return client format
        return clientFormat;
    }

    [inspect.custom](depth: number, options: InspectOptions) {
        return JSON.stringify(this.toData(), null, 2);
    }
}

export { SgVendor };
