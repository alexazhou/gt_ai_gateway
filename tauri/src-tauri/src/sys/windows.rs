use std::path::Path;
use std::process::Command;
use std::os::windows::process::CommandExt;

pub struct WindowsPlatformState {
    pub stdin: Option<std::process::ChildStdin>,
}
pub type PlatformState = WindowsPlatformState;

pub fn get_command(exe_dir: &Path) -> (Command, String) {
    #[cfg(debug_assertions)]
    {
        let project_root = exe_dir.join("../../../..");
        let mut c = Command::new("node");
        c.arg("--import").arg("tsx").arg("src/local.ts");
        c.current_dir(&project_root);
        (c, project_root.join("resource/migrate").to_string_lossy().into_owned())
    }
    
    #[cfg(not(debug_assertions))]
    {
        let sidecar_path = exe_dir.join("ai-gateway-backend.exe");
        let resource_dir = exe_dir.join("resource");
        let mut c = Command::new(&sidecar_path);
        c.arg("--api-only");
        c.arg("--desktop-mode");
        (c, resource_dir.join("migrate").to_string_lossy().into_owned())
    }
}

/// 为后端进程配置 stdio 管道。三路各自的归属（改这里必须同步改 lib.rs）：
///   - stdin  → `post_spawn` 收进 `PlatformState`，作为父进程存活探针
///   - stdout / stderr → `utils::watch_piped_stdio` 一并接管（stdout 驱动启动状态机，stderr 只记日志）
/// 被接成管道的 stdio 必须有读取者：无人读取时，子进程写满缓冲区（Windows 约 64 KiB）后写端会被阻塞，
/// 而 Node.js 在 Windows 上对管道是同步写，会直接卡死后端主线程。
pub fn setup_command(cmd: &mut Command) -> PlatformState {
    // Windows: 使用 pipes 代替 PTY，隐藏控制台窗口
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    // 打开 stdin 管道，借由 Tauri 父进程对其保持持有，使得后端可以通过监听 stdin 断开来感知父进程退出
    cmd.stdin(std::process::Stdio::piped());
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    
    WindowsPlatformState { stdin: None }
}

pub fn post_spawn(state: &mut PlatformState, child: &mut std::process::Child) {
    // 接管子进程的 stdin，存入 state 随 Tauri 进程存活。
    // Tauri 退出或崩溃时被释放，子进程 stdin 管道将收到 close/end 事件从而自动清理
    state.stdin = child.stdin.take();
}

pub fn set_dock_visibility(_app: &tauri::AppHandle, _visible: bool) {}

/// 处理平台特有的事件；Windows 上没有这类事件，一律交回调用方做通用处理。
pub fn handle_run_event(_app: &tauri::AppHandle, _event: &tauri::RunEvent) -> bool {
    false
}
