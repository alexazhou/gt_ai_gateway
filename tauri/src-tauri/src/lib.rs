mod sys;

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

static BACKEND_EXIT_CODE: AtomicI32 = AtomicI32::new(0);
static BACKEND_HAS_EXITED: AtomicBool = AtomicBool::new(false);
static BACKEND_IS_READY: AtomicBool = AtomicBool::new(false);

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    path::BaseDirectory,
    tray::TrayIconBuilder,
    Manager, WindowEvent,
};

const DEFAULT_PORT: u16 = 6722;
const DEFAULT_HOST: &str = "127.0.0.1";

/// 存储后端实际使用的 URL，供前端通过 Tauri 命令查询
struct BackendUrl(String);

/// 存储 root token，供前端自动登录
struct AuthToken(String);


/// Tauri 命令：返回后端服务的实际 URL
#[tauri::command]
fn get_backend_url(state: tauri::State<BackendUrl>) -> String {
    let url = state.0.clone();
    println!("RUST: get_backend_url called, url={}", url);
    url
}

/// Tauri 命令：返回 root token，供前端自动登录
#[tauri::command]
fn get_auth_token(state: tauri::State<AuthToken>) -> String {
    let token = state.0.clone();
    println!("RUST: get_auth_token called, token={:.8}...", token);
    token
}

#[tauri::command]
fn exit_app() {
    std::process::exit(1);
}

#[tauri::command]
async fn open_main_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(splash) = app.get_webview_window("splashscreen") {
        let _ = splash.close();
    }
    tauri::async_runtime::spawn_blocking(move || {
        show_main_window(&app)
    }).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn check_backend_status() -> Result<(), i32> {
    let code = BACKEND_EXIT_CODE.load(Ordering::SeqCst);
    let has_exited = BACKEND_HAS_EXITED.load(Ordering::SeqCst);
    if has_exited && !BACKEND_IS_READY.load(Ordering::SeqCst) {
        Err(code)
    } else if code != 0 {
        Err(code)
    } else {
        Ok(())
    }
}

#[tauri::command]
fn is_backend_ready() -> bool {
    BACKEND_IS_READY.load(Ordering::SeqCst)
}

#[tauri::command]
fn log_to_rust(msg: String) {
    println!("RUST: FRONTEND_LOG: {}", msg);
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
    println!("RUST: show_main_window called");
    if let Some(window) = app.get_webview_window("main") {
        println!("RUST: main window already exists, showing it");
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let _ = tauri::WebviewWindowBuilder::new(
        app,
        "main",
        tauri::WebviewUrl::App("index.html".into())
    )
    .title("GT AI Gateway")
    .title_bar_style(tauri::TitleBarStyle::Transparent)
    .hidden_title(true)
    .inner_size(1280.0, 800.0)
    .resizable(true)
    .devtools(true)
    .build()
    .map(|_| println!("RUST: main window created successfully"))
    .map_err(|e| println!("RUST: FAILED to create main window: {:?}", e));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![get_backend_url, get_auth_token, exit_app, open_main_window, check_backend_status, is_backend_ready, log_to_rust])
        .setup(|app| {
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

            // sidecar 二进制与主可执行文件同目录（Tauri bundle 时去掉 target triple）
            let exe_dir = std::env::current_exe()
                .expect("failed to get exe path")
                .parent()
                .expect("exe has no parent dir")
                .to_path_buf();

            let (mut cmd, migration_dir) = sys::platform::get_command(&exe_dir);

            // 设置环境变量
            println!("RUST: exe_dir={:?}", exe_dir);
            println!("RUST: data_dir={:?}", app_data_dir);
            println!("RUST: log_dir={:?}", log_dir);
            println!("RUST: db_path={:?}", db_path);
            println!("RUST: port={}", config.port);
            println!("RUST: migration_dir={:?}", migration_dir);
            println!("RUST: HELLO_1");
            println!("RUST: HELLO_2");

            cmd.env("DB_PATH", db_path.to_str().unwrap())
               .env("PORT", config.port.to_string())
               .env("HOST", &config.host)
               .env("LOG_DIR", log_dir.to_str().unwrap())
               .env("ROOT_TOKEN", &config.root_token)
               .env("DESKTOP_MODE", "1")
               .env("MIGRATION_DIR", migration_dir);

            let mut state = sys::platform::setup_command(&mut cmd);

            let mut child = cmd.spawn().expect("failed to spawn backend sidecar");
            let stdout = child.stdout.take();

            sys::platform::post_spawn(&mut state, &mut child);
            app.manage(state);

            let app_handle_clone = app.handle().clone();
            std::thread::spawn(move || {
                use tauri::Emitter;
                use std::io::{BufRead, BufReader};
                println!("RUST: STDOUT_READER_THREAD_STARTED");

                // 持续读取 stdout，直到进程退出管道关闭（这同时充当了 drain 的作用，防止子进程被阻塞）
                if let Some(out) = stdout {
                    let reader = BufReader::new(out);
                    for line in reader.lines() {
                        if let Ok(line_str) = line {
                            println!("RUST RECEIVED: {}", line_str);
                            // 检测到成功启动的关键日志
                            if line_str.contains("Server listening on") {
                                BACKEND_IS_READY.store(true, Ordering::SeqCst);
                                let _ = app_handle_clone.emit("backend-ready", ());

                            }
                        } else if let Err(e) = line {
                            println!("RUST STDOUT READ ERROR: {:?}", e);
                        }
                    }
                }

                // stdout 结束后（意味着子进程已经退出），收集退出码
                if let Ok(status) = child.wait() {
                    if let Some(code) = status.code() {
                        BACKEND_EXIT_CODE.store(code, Ordering::SeqCst);
                        BACKEND_HAS_EXITED.store(true, Ordering::SeqCst);
                        if !BACKEND_IS_READY.load(Ordering::SeqCst) || code != 0 {
                            let _ = app_handle_clone.emit("backend-error", code);
                        }
                    } else {
                        BACKEND_EXIT_CODE.store(1, Ordering::SeqCst);
                        BACKEND_HAS_EXITED.store(true, Ordering::SeqCst);
                        if !BACKEND_IS_READY.load(Ordering::SeqCst) {
                            let _ = app_handle_clone.emit("backend-error", 1);
                        }
                    }
                }
            });



            // 存储后端 URL 和 auth token，供前端查询
            let backend_url = format!("http://{}:{}", config.host, config.port);
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

            Ok(())
        })
        .on_window_event(|_window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                // window is naturally closed and destroyed, saving memory
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
                    show_main_window(app_handle);
                }
            }
            _ => {}
        });
}
