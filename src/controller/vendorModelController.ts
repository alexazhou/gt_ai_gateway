import { Context } from "hono";
import { SgVendor } from "../model/sgVendor";
import { SgVendorModel } from "../model/sgVendorModel";
import customError from "../util/customError";
import { ApiFormat } from "../constants";

const NON_LLM_PATTERNS = [
    /embedding/i,
    /rerank/i,
    /\btts\b/i,
    /text-to-speech/i,
    /speech-to-text/i,
    /whisper/i,
    /dall-e/i,
    /stable-diffusion/i,
    /image/i,           // 包含 image 关键字（图像生成模型）
    /image2video/i,
    /video-gen/i,
    /video/i,           // 视频生成模型
    /ocr/i,             // OCR 模型
    /livetranslate/i,   // 实时翻译
    /realtime-asr/i,    // 实时语音识别
    /moderation/i,
    /^wanx/i,           // Aliyun wanx 图像/视频生成
    /^wan\d/i,          // Aliyun wan2.7 等系列
    /^cosyvoice/i,      // Aliyun 语音合成
    /^sensevoice/i,     // Aliyun 语音识别
    /^sambert/i,        // Aliyun 语音
    /^paraformer/i,     // Aliyun 语音识别
];

function isLlmModel(modelId: string): boolean {
    return !NON_LLM_PATTERNS.some(pattern => pattern.test(modelId));
}


async function listVendorModels(c: Context) {
    const vendorId = parseInt(c.req.param("id"), 10);
    if (isNaN(vendorId)) {
        throw new customError.AppError("Invalid ID format");
    }

    const models = await SgVendorModel.query()
        .where("vendor_id", vendorId)
        .orderBy("model_id", "asc")
        .get();

    return c.json(models);
}


async function fetchVendorModels(c: Context) {
    const vendorId = parseInt(c.req.param("id"), 10);
    if (isNaN(vendorId)) {
        throw new customError.AppError("Invalid ID format");
    }

    const vendor = await SgVendor.query().find(vendorId);
    if (!vendor) {
        throw new customError.NotFoundError("Vendor not found");
    }

    // 取 openai URL，去掉 /chat/completions 后缀，拼 /models
    const openaiUrl = vendor.getUrlByFormat(ApiFormat.OPENAI);
    const baseUrl = openaiUrl.replace(/\/chat\/completions$/, "");
    const modelsUrl = `${baseUrl}/models`;

    const token = vendor.token;
    const authHeader = token.startsWith("Bearer ") ? token : `Bearer ${token}`;

    try {
        const response = await fetch(modelsUrl, {
            method: "GET",
            headers: {
                Authorization: authHeader,
                "Content-Type": "application/json",
            },
        });

        if (!response.ok) {
            const text = await response.text();
            throw new customError.AppError(
                `Upstream returned ${response.status}: ${text}`,
                502,
            );
        }

        const data: any = await response.json();

        // OpenAI /v1/models 返回 { object: "list", data: [{ id, ... }, ...] }
        const models: string[] = Array.isArray(data?.data)
            ? data.data.map((m: any) => m.id).filter(Boolean).filter(isLlmModel)
            : [];

        return c.json({ models });
    } catch (err: any) {
        if (err.statusCode) throw err;
        throw new customError.AppError(`Failed to fetch models: ${err.message}`, 502);
    }
}


async function syncVendorModels(c: Context) {
    const vendorId = parseInt(c.req.param("id"), 10);
    if (isNaN(vendorId)) {
        throw new customError.AppError("Invalid ID format");
    }

    const vendor = await SgVendor.query().find(vendorId);
    if (!vendor) {
        throw new customError.NotFoundError("Vendor not found");
    }

    const body = await c.req.json();
    const { model_ids } = body;

    if (!Array.isArray(model_ids)) {
        throw new customError.AppError("model_ids must be an array");
    }

    // 删除该 vendor 下所有旧记录，重新插入选中的
    await SgVendorModel.query().where("vendor_id", vendorId).delete();

    if (model_ids.length > 0) {
        for (const modelId of model_ids) {
            await SgVendorModel.query().create({
                vendor_id: vendorId,
                model_id: modelId,
            });
        }
    }

    const updated = await SgVendorModel.query()
        .where("vendor_id", vendorId)
        .orderBy("model_id", "asc")
        .get();

    return c.json(updated);
}


async function addVendorModel(c: Context) {
    const vendorId = parseInt(c.req.param("id"), 10);
    if (isNaN(vendorId)) {
        throw new customError.AppError("Invalid ID format");
    }

    const vendor = await SgVendor.query().find(vendorId);
    if (!vendor) {
        throw new customError.NotFoundError("Vendor not found");
    }

    const body = await c.req.json();
    const { model_id } = body;

    if (!model_id || typeof model_id !== "string" || !model_id.trim()) {
        throw new customError.AppError("model_id is required");
    }

    const trimmed = model_id.trim();

    const existing = await SgVendorModel.query()
        .where("vendor_id", vendorId)
        .where("model_id", trimmed)
        .first();

    if (existing) {
        throw new customError.AppError("Model already exists", 409);
    }

    const record = await SgVendorModel.query().create({
        vendor_id: vendorId,
        model_id: trimmed,
    });

    return c.json(record);
}


async function deleteVendorModel(c: Context) {
    const vendorId = parseInt(c.req.param("id"), 10);
    const recordId = parseInt(c.req.param("modelId"), 10);

    if (isNaN(vendorId) || isNaN(recordId)) {
        throw new customError.AppError("Invalid ID format");
    }

    const record = await SgVendorModel.query()
        .where("id", recordId)
        .where("vendor_id", vendorId)
        .first();

    if (!record) {
        throw new customError.NotFoundError("Vendor model not found");
    }

    await SgVendorModel.query().where("id", recordId).delete();

    return c.json({ success: true });
}


export default {
    listVendorModels,
    fetchVendorModels,
    syncVendorModels,
    addVendorModel,
    deleteVendorModel,
};
