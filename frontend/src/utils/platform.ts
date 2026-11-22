/**
 * Checks if the application is running in the Tauri desktop environment.
 * @returns {boolean} true if running in Tauri, false otherwise
 */
export function isTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Checks if the application is running in Tauri on macOS.
 * macOS 使用全尺寸内容视图（红绿灯浮在页面内容上），
 * 只有该场景下需要为窗口按钮预留顶部拖动区。
 * @returns {boolean} true if running in Tauri on macOS, false otherwise
 */
export function isMacTauri(): boolean {
    return isTauri() && typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');
}

/**
 * Checks if the application is running in Tauri on Windows.
 * Windows 使用无边框窗口，标题栏由前端自绘，需要渲染窗口控制按钮。
 * @returns {boolean} true if running in Tauri on Windows, false otherwise
 */
export function isWindowsTauri(): boolean {
    return isTauri() && typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');
}

/**
 * Opens a URL in the default system browser.
 * In Tauri, it uses the shell plugin to open natively.
 * In Web, it uses window.open.
 * 
 * @param {string} url The URL to open
 */
export async function openUrl(url: string): Promise<void> {
    if (isTauri()) {
        try {
            const { open } = await import('@tauri-apps/plugin-shell');
            await open(url);
            return;
        } catch (e) {
            console.error('Failed to open url via tauri shell', e);
        }
    }
    window.open(url, '_blank', 'noopener,noreferrer');
}
