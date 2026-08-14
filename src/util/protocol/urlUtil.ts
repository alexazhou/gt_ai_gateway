/**
 * 将 OPENAI 格式的 URL 转换为 RESPONSES 格式
 * 将 /chat/completions 替换为 /responses。
 * 非标准 OpenAI URL（不以 /chat/completions 结尾）无法识别，返回 null
 */
function convertOpenaiToResponses(url: string): string | null {
    if (!/\/chat\/completions$/.test(url)) {
        return null;
    }
    return url.replace(/\/chat\/completions$/, "/responses");
}

export default {
    convertOpenaiToResponses,
};
