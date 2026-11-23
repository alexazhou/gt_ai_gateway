use tauri::{Manager, Runtime, WebviewWindow, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
pub fn apply_main_window_style<'a, R, M>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M>
where
    R: Runtime,
    M: Manager<R>,
{
    // 全尺寸内容视图：窗口内容延伸到标题栏区域，红绿灯浮在应用顶栏上方，
    // 由前端在顶部预留一条拖动区，从而压缩整体顶栏高度并去掉原生分割线
    builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
}

#[cfg(target_os = "windows")]
pub fn apply_main_window_style<'a, R, M>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M>
where
    R: Runtime,
    M: Manager<R>,
{
    // 无边框窗口：品牌区在侧边栏顶部，窗口按钮由前端右上角自绘，
    // 保留系统阴影与缩放边框
    builder.decorations(false).shadow(true)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn apply_main_window_style<'a, R, M>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M>
where
    R: Runtime,
    M: Manager<R>,
{
    builder
}

/// 让原生标题栏底色跟随应用主题，消除系统标题栏与应用顶栏之间的色差和分割线。
/// 前端在启动和切换主题时调用。
pub fn apply_window_theme<R: Runtime>(window: &WebviewWindow<R>, is_dark: bool) {
    #[cfg(target_os = "macos")]
    {
        // 透明标题栏显示的是 NSWindow 背景色，必须与应用顶栏的 --bg-header 保持一致
        let color = if is_dark {
            tauri::window::Color(31, 31, 31, 255)
        } else {
            tauri::window::Color(255, 255, 255, 255)
        };
        let _ = window.set_background_color(Some(color));
    }

    #[cfg(windows)]
    {
        let Ok(hwnd) = window.hwnd() else {
            return;
        };

        // COLORREF 格式为 0x00BBGGRR，与顶栏的 #ffffff / #1f1f1f 对应
        let caption_color: u32 = if is_dark { 0x001F_1F1F } else { 0x00FF_FFFF };
        let dark_mode: i32 = i32::from(is_dark);

        const DWMWA_USE_IMMERSIVE_DARK_MODE: u32 = 20;
        const DWMWA_BORDER_COLOR: u32 = 34;
        const DWMWA_CAPTION_COLOR: u32 = 35;
        const DWMWA_COLOR_NONE: u32 = 0xFFFF_FFFE;

        unsafe {
            // 去掉窗口边框，标题栏与客户区之间不再出现分割线
            let _ = DwmSetWindowAttribute(
                hwnd.0 as isize,
                DWMWA_BORDER_COLOR,
                &DWMWA_COLOR_NONE as *const u32 as *const core::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            );
            // 标题栏底色与前端顶栏一致
            let _ = DwmSetWindowAttribute(
                hwnd.0 as isize,
                DWMWA_CAPTION_COLOR,
                &caption_color as *const u32 as *const core::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            );
            // 深色主题下标题文字/窗口按钮使用浅色
            let _ = DwmSetWindowAttribute(
                hwnd.0 as isize,
                DWMWA_USE_IMMERSIVE_DARK_MODE,
                &dark_mode as *const i32 as *const core::ffi::c_void,
                std::mem::size_of::<i32>() as u32,
            );
        }
    }

    #[cfg(all(not(target_os = "macos"), not(windows)))]
    {
        let _ = (window, is_dark);
    }
}

#[cfg(windows)]
#[link(name = "dwmapi")]
extern "system" {
    fn DwmSetWindowAttribute(
        hwnd: isize,
        dw_attribute: u32,
        pv_attribute: *const core::ffi::c_void,
        cb_attribute: u32,
    ) -> i32;
}
