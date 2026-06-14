use std::fs;
use std::os::unix::io::{FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::sync::Mutex;
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

const DEFAULT_PORT: u16 = 8787;
const DEFAULT_HOST: &str = "127.0.0.1";

/// 存储后端实际使用的 URL，供前端通过 Tauri 命令查询
struct BackendUrl(String);

/// 存储 root token，供前端自动登录
struct AuthToken(String);

/// 持有 PTY master fd（OwnedFd）。
/// Tauri 进程退出时（包括 kill -9），OwnedFd 被 drop，OS 关闭 master fd，
/// 内核向 backend 进程组发送 SIGHUP，backend 自动退出，不留孤儿进程。
#[allow(dead_code)]
struct PtyMaster(Mutex<Option<OwnedFd>>);

/// Tauri 命令：返回后端服务的实际 URL
#[tauri::command]
fn get_backend_url(state: tauri::State<BackendUrl>) -> String {
    state.0.clone()
}

/// Tauri 命令：返回 root token，供前端自动登录
#[tauri::command]
fn get_auth_token(state: tauri::State<AuthToken>) -> String {
    state.0.clone()
}

#[tauri::command]
fn exit_app() {
    std::process::exit(1);
}

#[tauri::command]
fn open_main_window(app: tauri::AppHandle) {
    if let Some(splash) = app.get_webview_window("splashscreen") {
        let _ = splash.close();
    }
    show_main_window(&app);
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

/// 打开 PTY，返回 (master_fd, slave_path)。
/// master 设置了 O_CLOEXEC 避免被子进程继承（子进程通过 slave 通信）。
unsafe fn open_pty() -> Result<(RawFd, String), String> {
    let master = libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC);
    if master < 0 {
        return Err(format!("posix_openpt failed: {}", std::io::Error::last_os_error()));
    }
    if libc::grantpt(master) < 0 || libc::unlockpt(master) < 0 {
        libc::close(master);
        return Err("grantpt/unlockpt failed".into());
    }

    // macOS 的 ptsname() 是线程安全的
    let slave_ptr = libc::ptsname(master);
    if slave_ptr.is_null() {
        libc::close(master);
        return Err("ptsname failed".into());
    }
    let slave_path = std::ffi::CStr::from_ptr(slave_ptr)
        .to_string_lossy()
        .into_owned();

    Ok((master, slave_path))
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    } else {
        let _ = tauri::WebviewWindowBuilder::new(
            app,
            "main",
            tauri::WebviewUrl::App("index.html".into())
        )
        .title("")
        .inner_size(1280.0, 800.0)
        .resizable(true)
        .hidden_title(true)
        .build();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![get_backend_url, get_auth_token, exit_app, open_main_window, check_backend_status, is_backend_ready])
        .setup(|app| {
            let app_data_dir = app
                .path()
                .data_dir()
                .expect("failed to get data dir")
                .join("GtCoder")
                .join("AiGateway");

            fs::create_dir_all(&app_data_dir)?;

            let db_path = app_data_dir.join("gateway.db");
            let config = read_config(&app_data_dir);
            let log_dir = app_data_dir.join("logs");

            // sidecar 二进制与主可执行文件同目录（Tauri bundle 时去掉 target triple）
            let exe_dir = std::env::current_exe()
                .expect("failed to get exe path")
                .parent()
                .expect("exe has no parent dir")
                .to_path_buf();

            #[cfg(not(debug_assertions))]
            let (mut cmd, migration_dir) = {
                let sidecar_path = exe_dir.join("ai-gateway-backend");
                // resource 文件在 .app/Contents/Resources/resource/ 下
                let resource_dir = exe_dir.join("../Resources/resource");
                let c = std::process::Command::new(&sidecar_path);
                (c, resource_dir.join("migrate").to_string_lossy().into_owned())
            };

            #[cfg(debug_assertions)]
            let (mut cmd, migration_dir) = {
                // Dev 模式下直接运行源码，实现热加载，同时避免被 pkg 构建覆盖
                let project_root = exe_dir.join("../../../..");
                let is_apple_silicon = std::process::Command::new("uname")
                    .arg("-m")
                    .output()
                    .map(|output| String::from_utf8_lossy(&output.stdout).trim() == "arm64")
                    .unwrap_or(false);
                let mut c = if cfg!(target_os = "macos") && is_apple_silicon {
                    let mut command = std::process::Command::new("/usr/bin/arch");
                    command.arg("-arm64").arg("node");
                    command
                } else {
                    std::process::Command::new("node")
                };
                c.arg("--import").arg("tsx").arg("src/local.ts");
                c.current_dir(&project_root);
                (c, project_root.join("resource/migrate").to_string_lossy().into_owned())
            };

            // 打开 PTY pair
            let (master_raw, slave_path) = unsafe { open_pty() }
                .expect("failed to open PTY");

            // 打开 slave
            let slave_path_c = std::ffi::CString::new(slave_path).unwrap();
            let slave_raw: RawFd = unsafe {
                libc::open(slave_path_c.as_ptr(), libc::O_RDWR)
            };
            if slave_raw < 0 {
                panic!("failed to open PTY slave: {}", std::io::Error::last_os_error());
            }

            // 构造命令，继承当前环境并追加我们的变量
            cmd.env("DB_PATH", db_path.to_str().unwrap())
               .env("PORT", config.port.to_string())
               .env("HOST", &config.host)
               .env("LOG_DIR", log_dir.to_str().unwrap())
               .env("ROOT_TOKEN", &config.root_token)
               .env("DESKTOP_MODE", "1")
               .env("MIGRATION_DIR", migration_dir);

            // pre_exec：在 fork 之后、exec 之前在子进程中执行
            unsafe {
                cmd.pre_exec(move || {
                    // 1. 创建新 session，脱离父进程的进程组
                    libc::setsid();

                    // 2. 将 PTY slave 设为该 session 的控制终端
                    libc::ioctl(slave_raw, libc::TIOCSCTTY as u64, 0);

                    // 3. stdin 保持 slave（维持控制终端关系），stderr 指向 /dev/null
                    //    stdout 不再指向 /dev/null，而是通过 pipe 传回 Rust，以供启动状态检测
                    libc::dup2(slave_raw, 0);
                    let devnull = libc::open(b"/dev/null\0".as_ptr() as *const _, libc::O_RDWR);
                    if devnull >= 0 {
                        libc::dup2(devnull, 2); // 只重定向 stderr
                        libc::close(devnull);
                    }

                    // 4. 关闭所有多余的 FD（>= 3），包括从 Tauri 继承的
                    //    WebView/CoreFoundation/网络等 FD，防止干扰 Node.js 事件循环
                    let mut rl = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
                    libc::getrlimit(libc::RLIMIT_NOFILE, &mut rl);
                    let max_fd = std::cmp::min(rl.rlim_cur as i32, 4096);
                    for fd in 3..max_fd {
                        libc::close(fd);
                    }

                    Ok(())
                });
            }

            // 管道接收 stdout
            cmd.stdout(std::process::Stdio::piped());

            let mut child = cmd.spawn().expect("failed to spawn backend sidecar");
            let stdout = child.stdout.take();

            let app_handle_clone = app.handle().clone();
            std::thread::spawn(move || {
                use tauri::Emitter;
                use std::io::{BufRead, BufReader};

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

            // 父进程关闭 slave（已在子进程中 dup 到 0/1/2）
            unsafe { libc::close(slave_raw); }

            // PTY master 存入 managed state，保持其存活
            // Tauri 退出时 OwnedFd drop → master fd 关闭 → 内核发 SIGHUP → backend 退出
            let master_owned = unsafe { OwnedFd::from_raw_fd(master_raw) };
            app.manage(PtyMaster(Mutex::new(Some(master_owned))));

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
