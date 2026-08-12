import { Model } from "sutando";
import { inspect, InspectOptions } from "util";
import { ApiFormat } from "../constants";

class SgVendorModel extends Model {
    table = "vendor_model";

    id!: number;
    vendor_id!: number;
    model_id!: string;
    allowed_formats!: string | null;

    created_at!: Date;
    updated_at!: Date;

    getAllowedFormats(): ApiFormat[] | null {
        if (!this.allowed_formats) return null;
        try { return JSON.parse(this.allowed_formats) as ApiFormat[]; } catch { return null; }
    }

    /**
     * 获取当前 vendorModel 支持的格式列表
     * 语义：allowed_formats 为 null/空时表示未指定，路由层回退到 vendor 按 URL 自动判断；
     *       非空时作为硬限制白名单，只允许列表内的格式。
     * @returns 支持的格式数组，未配置时返回 null
     */
    getSupportedFormats(): ApiFormat[] | null {
        return this.getAllowedFormats();
    }

    [inspect.custom](depth: number, options: InspectOptions) {
        return JSON.stringify(this.toData(), null, 2);
    }
}

export { SgVendorModel };
