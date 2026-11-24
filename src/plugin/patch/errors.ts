/**
 * 补丁被拒的统一错误类型。
 *
 * 拒绝是**整份**的：任一操作违规即整份补丁不应用（`applyBodyPatch` / `applyHeaderPatch`
 * 都先全量校验、再落地），因此这里抛出的错误意味着「本次插件的一次都没生效」，
 * 管线层据 `code` 决定记时间线还是吞掉（两者都不影响请求继续发出）。
 */
export type PatchRejectionCode =
    /** 试图替换根对象（path 为 "" 或 "/"） */
    | "root_replacement"
    /** JSON Pointer 语法非法 */
    | "invalid_pointer"
    /** 试图改写受保护请求体字段（model / stream / stream_options） */
    | "protected_field"
    /** 试图改写受保护请求头（鉴权头 / 网关管控头 / cf- 与 sec- 前缀） */
    | "protected_header"
    /** 值不是 JSON 可表示的数据（undefined / function / NaN 等） */
    | "invalid_value"
    /** add / replace 缺 value，或 op 名字不认识 */
    | "invalid_operation"
    /** 路径上某一段不存在 */
    | "path_not_found"
    /** 数组下标非法（越界、非整数，或 replace/remove 用了 "-"） */
    | "invalid_index";

export class PatchRejectedError extends Error {
    constructor(
        message: string,
        readonly code: PatchRejectionCode,
        /** 出错的操作路径（请求体是 JSON Pointer，请求头是 header 名） */
        readonly path?: string,
    ) {
        super(message);
        this.name = "PatchRejectedError";
    }
}
