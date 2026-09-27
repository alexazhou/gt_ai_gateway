use std::path::Path;
use std::process::Command;
use tauri::Manager;

pub type PlatformState = crate::sys::unix::UnixPlatformState;

pub fn get_command(exe_dir: &Path) -> (Command, String) {
    #[cfg(debug_assertions)]
    {
        let project_root = exe_dir.join("../../../..");
        let is_apple_silicon = Command::new("uname")
            .arg("-m")
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).trim() == "arm64")
            .unwrap_or(false);
        
        let mut c = if is_apple_silicon {
            let mut command = Command::new("/usr/bin/arch");
            command.arg("-arm64").arg("node");
            command
        } else {
            Command::new("node")
        };
        c.arg("--import").arg("tsx").arg("src/local.ts");
        c.current_dir(&project_root);
        (c, project_root.join("resource/migrate").to_string_lossy().into_owned())
    }
    
    #[cfg(not(debug_assertions))]
    {
        let sidecar_path = exe_dir.join("ai-gateway-backend");
        let resource_dir = exe_dir.join("../Resources/resource");
        let mut c = Command::new(&sidecar_path);
        c.arg("--api-only");
        c.arg("--desktop-mode");
        (c, resource_dir.join("migrate").to_string_lossy().into_owned())
    }
}

pub fn setup_command(cmd: &mut Command) -> PlatformState {
    crate::sys::unix::setup_pty_command(cmd)
}

pub fn post_spawn(state: &mut PlatformState, child: &mut std::process::Child) {
    crate::sys::unix::post_spawn(state, child)
}

pub fn set_dock_visibility(app: &tauri::AppHandle, visible: bool) {
    let policy = if visible {
        tauri::ActivationPolicy::Regular
    } else {
        tauri::ActivationPolicy::Accessory
    };

    if let Err(e) = app.set_activation_policy(policy) {
        println!("RUST: failed to set dock visibility to {}: {:?}", visible, e);
    }
}

/// 处理平台特有的事件；返回 true 表示事件已由平台层处理，调用方不必再做通用处理。
///
/// macOS 独有：点击 Dock 图标重新打开应用。`RunEvent::Reopen` 只在 macOS 上存在
/// （Tauri 自身就给它标了 `#[cfg(target_os = "macos")]`），所以只有这个文件会匹配它。
pub fn handle_run_event(app: &tauri::AppHandle, event: &tauri::RunEvent) -> bool {
    match event {
        tauri::RunEvent::Reopen { has_visible_windows, .. } => {
            if !*has_visible_windows {
                if crate::backend_is_ready() {
                    crate::show_main_window(app);
                } else if let Some(splash) = app.get_webview_window("splashscreen") {
                    let _ = splash.show();
                    let _ = splash.set_focus();
                }
            }
            true
        }
        _ => false,
    }
}
