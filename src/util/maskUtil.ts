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


export default {
    maskToken,
};