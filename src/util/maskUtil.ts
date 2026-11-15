// 掩码敏感凭据：只保留前 4 位，其余用 * 代替，避免明文进日志
function maskToken(token: string): string {
    if (!token) {
        return "";
    }
    const length = token.length;
    if (length <= 4) {
        return "*".repeat(length);
    }
    return token.slice(0, 4) + "*".repeat(length - 4);
}


/**
 * 掩码 URL 中的 userinfo（`scheme://user:pass@host` → `scheme://****@host`）。
 * 代理地址常把账号密码写在 URL 里，回传前端时必须抹掉，否则等于明文外泄。
 * 无 userinfo 的 URL 原样返回。
 */
function maskUrlCredentials(url: string): string {
    if (!url) {
        return url;
    }
    return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/i, (_match, scheme: string) => `${scheme}****@`);
}


/**
 * 判断某个值是否是「已掩码」形态（只含 `*` 或 `前缀 + ***`，且含 `*`）。
 * 用于编辑接口区分「用户没改，原样回传了掩码值」与「用户真的改了」。
 */
function isMaskedValue(value: unknown): boolean {
    return typeof value === "string" && value.includes("*") && !/[^*]/.test(value.replace(/^[^*]{0,4}/, ""));
}


export default {
    maskToken,
    maskUrlCredentials,
    isMaskedValue,
};
