mod sys;
pub mod utils;

use crate::utils::{StdioEvent, StdioStream};

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
    OnceLock,
};
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
enum BackendError {
    ExitCode(i32),
    Message(String),
}

#[derive(Debug, Clone)]
enum BackendState {
    NotStarted,
    Starting,
    Migrating,
    Ready,
    Failed(BackendError),
    Exited(i32),
}

impl BackendError {
    fn describe(&self) -> String {
        match self {
            BackendError::ExitCode(code) => format!("ExitCode({})", code),
            BackendError::Message(message) => format!("Message({})", message),
        }
    }
}

impl BackendState {
    fn is_not_started(&self) -> bool {
        matches!(self, BackendState::NotStarted)
    }

    fn is_starting(&self) -> bool {
        matches!(self, BackendState::Starting)
    }

    fn is_migrating(&self) -> bool {
        matches!(self, BackendState::Migrating)
    }

    fn is_ready(&self) -> bool {
        matches!(self, BackendState::Ready)
    }

    fn is_waiting_for_ready(&self) -> bool {
        matches!(self, BackendState::Starting | BackendState::Migrating)
    }

    fn describe(&self) -> String {
        match self {
            BackendState::NotStarted => "NotStarted".to_string(),
            BackendState::Starting => "Starting".to_string(),
            BackendState::Migrating => "Migrating".to_string(),
            BackendState::Ready => "Ready".to_string(),
            BackendState::Failed(error) => format!("Failed({})", error.describe()),
            BackendState::Exited(code) => format!("Exited({})", code),
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct StartupGate {
    setup_finished: bool,
    splash_loaded: bool,
}

impl StartupGate {
    fn is_ready(&self) -> bool {
        self.setup_finished && self.splash_loaded
    }
}

static BACKEND_STATE: Mutex<BackendState> = Mutex::new(BackendState::NotStarted);
static STARTUP_GATE: Mutex<StartupGate> = Mutex::new(StartupGate {
    setup_finished: false,
    splash_loaded: false,
});
static BACKEND_START_TIMEOUT_GENERATION: AtomicU64 = AtomicU64::new(0);
static RUST_STARTED_AT: OnceLock<Instant> = OnceLock::new();

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    path::BaseDirectory,
    tray::TrayIconBuilder,
    webview::PageLoadEvent,
    Emitter, Manager, WindowEvent,
};

const DEFAULT_PORT: u16 = 6722;
const DEFAULT_HOST: &str = "127.0.0.1";
const MIGRATION_START_MARKER: &str = "[GT_AI_GATEWAY_MIGRATION_START]";
const MIGRATION_END_MARKER: &str = "[GT_AI_GATEWAY_MIGRATION_END]";
const BACKEND_START_TIMEOUT_MS: u64 = 15_000;

fn rust_log(message: impl std::fmt::Display) {
    let elapsed_ms = RUST_STARTED_AT.get_or_init(Instant::now).elapsed().as_millis();
    println!("RUST +{}ms: {}", elapsed_ms, message);
}

fn with_backend_state<T>(f: impl FnOnce(&mut BackendState) -> T) -> T {
    let mut state = BACKEND_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    f(&mut state)
}

fn backend_state_snapshot() -> BackendState {
    BACKEND_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn backend_is_ready() -> bool {
    backend_state_snapshot().is_ready()
}

fn backend_state_description() -> String {
    backend_state_snapshot().describe()
}

fn set_backend_failed(error: BackendError) {
    with_backend_state(|state| {
        *state = BackendState::Failed(error);
    });
}

fn emit_backend_error(app: &tauri::AppHandle, error: &BackendError) {
    match error {
        BackendError::ExitCode(code) => {
            let _ = app.emit("backend-error", *code);
        }
        BackendError::Message(message) => {
            let _ = app.emit("backend-error", message.clone());
        }
    }
}

fn with_startup_gate<T>(f: impl FnOnce(&mut StartupGate) -> T) -> T {
    let mut gate = STARTUP_GATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    f(&mut gate)
}

fn startup_gate_snapshot() -> StartupGate {
    STARTUP_GATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .to_owned()
}

/// 存储后端实际使用的 URL，供前端通过 Tauri 命令查询
struct BackendUrl(String);

/// 存储 root token，供前端自动登录
struct AuthToken(String);

struct BackendLaunchConfig {
    db_path: PathBuf,
    log_dir: PathBuf,
    port: u16,
    host: String,
    root_token: String,
}

struct BackendProcessState {
    platform_state: Mutex<Option<sys::platform::PlatformState>>,
}


/// Tauri 命令：返回后端服务的实际 URL
#[tauri::command]
fn get_backend_url(state: tauri::State<BackendUrl>) -> String {
    let url = state.0.clone();
    rust_log(format!("get_backend_url called, url={}", url));
    url
}

/// Tauri 命令：返回 root token，供前端自动登录
#[tauri::command]
fn get_auth_token(state: tauri::State<AuthToken>) -> String {
    let token = state.0.clone();
    rust_log(format!("get_auth_token called, token={:.8}...", token));
    token
}

#[tauri::command]
fn exit_app() {
    std::process::exit(1);
}

fn show_splash_window(app: &tauri::AppHandle) -> Result<(), String> {
    rust_log("show_splash_window invoked");
    if let Some(splash) = app.get_webview_window("splashscreen") {
        splash.show().map_err(|e| e.to_string())?;
        let _ = splash.set_focus();
        rust_log("splashscreen window shown");
        Ok(())
    } else {
        rust_log("splashscreen window not found when showing splash");
        Err("splashscreen window not found".to_string())
    }
}

fn open_main_window(app: &tauri::AppHandle) {
    rust_log("open_main_window invoked");
    if let Some(splash) = app.get_webview_window("splashscreen") {
        rust_log("closing splashscreen window");
        let _ = splash.close();
    } else {
        rust_log("splashscreen window not found when opening main window");
    }
    show_main_window(app);
}

fn cancel_backend_start_timeout() {
    BACKEND_START_TIMEOUT_GENERATION.fetch_add(1, Ordering::SeqCst);
}

fn schedule_backend_start_timeout(app: tauri::AppHandle) {
    let generation = BACKEND_START_TIMEOUT_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    rust_log(format!(
        "backend start timeout scheduled, generation={}, timeout_ms={}",
        generation, BACKEND_START_TIMEOUT_MS,
    ));

    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(BACKEND_START_TIMEOUT_MS));

        if BACKEND_START_TIMEOUT_GENERATION.load(Ordering::SeqCst) != generation {
            rust_log(format!(
                "backend start timeout ignored, generation={}",
                generation
            ));
            return;
        }

        let timed_out = with_backend_state(|state| {
            if state.is_starting() {
                *state = BackendState::Failed(BackendError::Message(
                    "后端启动超时：15 秒内没有收到后端就绪事件。".to_string(),
                ));
                true
            } else {
                false
            }
        });

        if !timed_out {
            rust_log(format!(
                "backend start timeout skipped, state={}",
                backend_state_description(),
            ));
            return;
        }

        rust_log("backend start timed out");
        let _ = app.emit(
            "backend-error",
            "后端启动超时：15 秒内没有收到后端就绪事件。",
        );
    });
}

fn maybe_start_backend_after_splash_load(app: tauri::AppHandle) {
    let startup_gate = startup_gate_snapshot();
    if !startup_gate.is_ready() {
        if !startup_gate.splash_loaded {
            rust_log("backend start deferred, splash page not loaded yet");
        }
        if !startup_gate.setup_finished {
            rust_log("backend start deferred, app setup not finished yet");
        }
        return;
    }

    if backend_is_ready() {
        rust_log("backend start skipped, backend is already ready");
        return;
    }

    let should_start = with_backend_state(|state| {
        if state.is_not_started() {
            *state = BackendState::Starting;
            true
        } else {
            false
        }
    });
    if !should_start {
        rust_log(format!(
            "backend start skipped, state={}",
            backend_state_description(),
        ));
        return;
    }

    if let Err(error) = show_splash_window(&app) {
        let backend_error = BackendError::Message(error.clone());
        set_backend_failed(backend_error.clone());
        rust_log(format!(
            "failed to show splash before backend start: {}",
            error
        ));
        emit_backend_error(&app, &backend_error);
        return;
    }

    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = start_backend_process(&app) {
            let backend_error = BackendError::Message(error.clone());
            set_backend_failed(backend_error.clone());
            rust_log(format!("failed to start backend process: {}", error));
            emit_backend_error(&app, &backend_error);
        }
    });
}

fn start_backend_process(app: &tauri::AppHandle) -> Result<(), String> {
    let launch_config = app.state::<BackendLaunchConfig>();
    let db_path = launch_config.db_path.clone();
    let log_dir = launch_config.log_dir.clone();
    let port = launch_config.port;
    let host = launch_config.host.clone();
    let root_token = launch_config.root_token.clone();

    let exe_dir = std::env::current_exe()
        .map_err(|e| format!("failed to get exe path: {}", e))?
        .parent()
        .ok_or_else(|| "exe has no parent dir".to_string())?
        .to_path_buf();

    let (mut cmd, migration_dir) = sys::platform::get_command(&exe_dir);

    rust_log(format!("starting backend, exe_dir={:?}", exe_dir));
    rust_log(format!("backend data db_path={:?}", db_path));
    rust_log(format!("backend log_dir={:?}", log_dir));
    rust_log(format!("backend port={}", port));
    rust_log(format!("backend migration_dir={:?}", migration_dir));

    cmd.env("DB_PATH", db_path.to_str().unwrap())
        .env("PORT", port.to_string())
        .env("HOST", &host)
        .env("LOG_DIR", log_dir.to_str().unwrap())
        .env("ROOT_TOKEN", &root_token)
        .arg("--desktop-mode")
        .env("MIGRATION_DIR", migration_dir);

    let mut platform_state = sys::platform::setup_command(&mut cmd);
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            return Err(format!("failed to spawn backend sidecar: {}", e));
        }
    };
    sys::platform::post_spawn(&mut platform_state, &mut child);

    let process_state = app.state::<BackendProcessState>();
    let mut stored_platform_state = process_state
        .platform_state
        .lock()
        .map_err(|e| e.to_string())?;
    *stored_platform_state = Some(platform_state);
    drop(stored_platform_state);

    schedule_backend_start_timeout(app.clone());

    // stdout / stderr 都是管道，一并交给 watch_piped_stdio 接管；漏掉任何一路都会让后端在写满缓冲区后卡死
    utils::watch_piped_stdio(child, {
        let app_for_stdout = app.clone();
        let app_for_exit = app.clone();
        move |event| match event {
            StdioEvent::ReaderStarted(stream) => {
                rust_log(format!("{}_READER_THREAD_STARTED", stream.label()))
            }
            StdioEvent::ReaderFinished(stream) => {
                rust_log(format!("{}_READER_THREAD_FINISHED", stream.label()))
            }
            StdioEvent::Line(StdioStream::Stdout, line) => {
                handle_backend_stdout_line(&app_for_stdout, &line)
            }
            StdioEvent::Line(StdioStream::Stderr, line) => {
                rust_log(format!("BACKEND_STDERR: {}", line))
            }
            StdioEvent::ReadError(stream, message) => {
                rust_log(format!("{} READ ERROR: {}", stream.label(), message))
            }
            StdioEvent::Exited(code) => handle_backend_exit(&app_for_exit, code),
        }
    });
    rust_log("backend process spawned");
    Ok(())
}

/// 处理一行后端 stdout：转发日志、驱动启动状态机
fn handle_backend_stdout_line(app_handle: &tauri::AppHandle, line_str: &str) {
    rust_log(format!("BACKEND_STDOUT: {}", line_str));

    if line_str.contains(MIGRATION_START_MARKER) {
        let started = with_backend_state(|state| {
            if state.is_starting() {
                *state = BackendState::Migrating;
                true
            } else {
                false
            }
        });
        if started {
            cancel_backend_start_timeout();
            let _ = app_handle.emit("backend-migration-start", ());
        } else {
            rust_log(format!(
                "backend migration start ignored, state={}",
                backend_state_description(),
            ));
        }
    }

    if line_str.contains(MIGRATION_END_MARKER) {
        let ended = with_backend_state(|state| {
            if state.is_migrating() {
                *state = BackendState::Starting;
                true
            } else {
                false
            }
        });
        if ended {
            let _ = app_handle.emit("backend-migration-end", line_str.to_string());
            schedule_backend_start_timeout(app_handle.clone());
        } else {
            rust_log(format!(
                "backend migration end ignored, state={}",
                backend_state_description(),
            ));
        }
    }

    // 检测到成功启动的关键日志
    if line_str.contains("Server listening on") {
        let should_open = with_backend_state(|state| {
            if state.is_waiting_for_ready() {
                *state = BackendState::Ready;
                true
            } else {
                false
            }
        });
        if should_open {
            cancel_backend_start_timeout();
            let _ = app_handle.emit("backend-ready", ());
            open_main_window(app_handle);
        } else {
            rust_log(format!(
                "backend ready ignored, state={}",
                backend_state_description(),
            ));
        }
    }
}

/// 后端进程退出后的收尾：更新状态，必要时上报错误
fn handle_backend_exit(app_handle: &tauri::AppHandle, code: i32) {
    cancel_backend_start_timeout();
    let should_emit_error = with_backend_state(|state| match state {
        BackendState::Ready => {
            *state = BackendState::Exited(code);
            code != 0
        }
        BackendState::Failed(_) => false,
        _ => {
            *state = BackendState::Exited(code);
            true
        }
    });
    if should_emit_error {
        emit_backend_error(app_handle, &BackendError::ExitCode(code));
    }
}

#[tauri::command]
fn log_to_rust(msg: String) {
    rust_log(format!("FRONTEND_LOG: {}", msg));
}

struct AppConfig {
    port: u16,
    host: String,
    root_token: String,
}


/// 生成随机 token（UUID v4）
fn generate_random_token() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// 从 app_data_dir/config.json 读取配置。
/// 若文件不存在或缺少 root_token，自动生成并写入。
fn read_config(app_data_dir: &Path) -> AppConfig {
    let config_path = app_data_dir.join("config.json");

    let mut port = DEFAULT_PORT;
    let mut host = DEFAULT_HOST.to_string();
    let mut root_token = String::new();
    let mut need_write = false;

    if config_path.exists() {
        if let Ok(content) = fs::read_to_string(&config_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(p) = json["port"].as_u64() {
                    if p > 0 && p <= 65535 {
                        port = p as u16;
                    }
                }
                if let Some(h) = json["host"].as_str() {
                    if !h.is_empty() {
                        host = h.to_string();
                    }
                }
                if let Some(t) = json["root_token"].as_str() {
                    if !t.is_empty() {
                        root_token = t.to_string();
                    }
                }
            }
        }
    } else {
        need_write = true;
    }

    // 若 root_token 为空，自动生成一个 UUID
    if root_token.is_empty() {
        root_token = generate_random_token();
        need_write = true;
    }

    // 将配置写回文件（确保 root_token 持久化）
    if need_write {
        let config_json = serde_json::json!({
            "port": port,
            "host": host,
            "root_token": root_token
        });
        let _ = fs::write(
            &config_path,
            serde_json::to_string_pretty(&config_json).unwrap(),
        );
    }

    AppConfig { port, host, root_token }
}


fn show_main_window(app: &tauri::AppHandle) {
    rust_log("show_main_window called");
    sys::platform::set_dock_visibility(app, true);
    if let Some(window) = app.get_webview_window("main") {
        rust_log("main window already exists, showing it");
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let result = tauri::WebviewWindowBuilder::new(
        app,
        "main",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("GT AI Gateway")
    .inner_size(1280.0, 800.0)
    .resizable(true)
    .build();

    match result {
        Ok(_) => rust_log("main window created successfully"),
        Err(e) => rust_log(format!("FAILED to create main window: {:?}", e)),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = RUST_STARTED_AT.set(Instant::now());
    rust_log("run started");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_backend_url,
            get_auth_token,
            exit_app,
            log_to_rust
        ])
        .on_page_load(|webview, payload| {
            if webview.label() != "splashscreen" {
                return;
            }

            match payload.event() {
                PageLoadEvent::Started => {
                    rust_log(format!("splash page load started, url={}", payload.url()));
                }
                PageLoadEvent::Finished => {
                    rust_log(format!("splash page load finished, url={}", payload.url()));
                    with_startup_gate(|gate| {
                        gate.splash_loaded = true;
                    });
                    maybe_start_backend_after_splash_load(webview.app_handle().clone());
                }
            }
        })
        .setup(|app| {
            rust_log("setup started");
            rust_log(format!(
                "splashscreen window exists in setup={}",
                app.get_webview_window("splashscreen").is_some(),
            ));

            let app_data_dir = app
                .path()
                .data_dir()
                .expect("failed to get data dir")
                .join("GtCoder")
                .join("AiGateway");

            let log_dir = app_data_dir.join("logs");
            fs::create_dir_all(&app_data_dir)?;
            fs::create_dir_all(&log_dir)?;

            let db_path = app_data_dir.join("gateway.db");
            let config = read_config(&app_data_dir);

            rust_log(format!("data_dir={:?}", app_data_dir));
            rust_log(format!("log_dir={:?}", log_dir));
            rust_log(format!("db_path={:?}", db_path));
            rust_log(format!("port={}", config.port));
            rust_log("backend launch deferred until splash is visible");

            app.manage(BackendLaunchConfig {
                db_path: db_path.clone(),
                log_dir: log_dir.clone(),
                port: config.port,
                host: config.host.clone(),
                root_token: config.root_token.clone(),
            });
            app.manage(BackendProcessState {
                platform_state: Mutex::new(None),
            });

            // 存储后端 URL 和 auth token，供前端查询。如果配置为 0.0.0.0，前端连接应使用 127.0.0.1
            let backend_url = utils::generate_client_url(&config.host, config.port);
            app.manage(BackendUrl(backend_url));
            app.manage(AuthToken(config.root_token.clone()));

            // 把 app_data_dir 存入 managed state，供菜单事件回调使用
            app.manage(app_data_dir.clone());

            // 托盘菜单
            let show_item = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let open_config_item = MenuItem::with_id(app, "open_config", "打开配置目录", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &open_config_item, &quit_item])?;

            let tray_icon_path = app
                .path()
                .resolve("icons/tray-icon@2x.png", BaseDirectory::Resource);
            let tray_icon = tray_icon_path
                .ok()
                .and_then(|path| Image::from_path(path).ok())
                .unwrap_or_else(|| app.default_window_icon().unwrap().clone());

            TrayIconBuilder::new()
                .icon(tray_icon)
                .icon_as_template(true)
                .tooltip("GT AI Gateway")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        show_main_window(app);
                    }
                    "open_config" => {
                        let dir = app.state::<std::path::PathBuf>().inner().clone();
                        let _ = open::that(dir);
                    }
                    "quit" => {
                        std::process::exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            with_startup_gate(|gate| {
                gate.setup_finished = true;
            });
            maybe_start_backend_after_splash_load(app.handle().clone());
            rust_log("setup finished");
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                    sys::platform::set_dock_visibility(window.app_handle(), false);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            tauri::RunEvent::ExitRequested { api, .. } => {
                // Prevent the app from completely exiting when the last window closes
                api.prevent_exit();
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { has_visible_windows, .. } => {
                if !has_visible_windows {
                    if backend_is_ready() {
                        show_main_window(app_handle);
                    } else if let Some(splash) = app_handle.get_webview_window("splashscreen") {
                        let _ = splash.show();
                        let _ = splash.set_focus();
                    }
                }
            }
            _ => {}
        });
}
