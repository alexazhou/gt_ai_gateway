pub struct UnixPlatformState {
    pub stdin: Option<std::process::ChildStdin>,
}

/// 为后端进程配置 stdio 管道（函数名沿用历史，实际用的是 pipes 而非 PTY）。三路各自的归属
/// （改这里必须同步改 lib.rs）：
///   - stdin  → `post_spawn` 收进 `UnixPlatformState`，作为父进程存活探针
///   - stdout / stderr → `utils::watch_piped_stdio` 一并接管（stdout 驱动启动状态机，stderr 只记日志）
/// 被接成管道的 stdio 必须有读取者：无人读取时，子进程写满缓冲区后写端会被阻塞。类 Unix 上管道是异步写，
/// 表现为子进程侧无限缓冲；Windows（见 sys/windows.rs）则是同步写，会直接卡死后端主线程。
pub fn setup_pty_command(cmd: &mut std::process::Command) -> UnixPlatformState {
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    // 打开 stdin 管道，借由 Tauri 父进程对其保持持有，使得后端可以通过监听 stdin 断开来感知父进程退出
    cmd.stdin(std::process::Stdio::piped());
    
    UnixPlatformState { stdin: None }
}

pub fn post_spawn(state: &mut UnixPlatformState, child: &mut std::process::Child) {
    // 接管子进程的 stdin，存入 state 随 Tauri 进程存活。
    // Tauri 退出或崩溃时被释放，子进程 stdin 管道将收到 close/end 事件从而自动清理
    state.stdin = child.stdin.take();
}
