use std::fs;
use std::os::unix::io::{FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::sync::Mutex;

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
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

struct AppConfig {
    port: u16,
    host: String,
    root_token: String,
}

/// 生成随机 token（32 字符 hex）
fn generate_random_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{:032x}", seed ^ (seed >> 64))
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

    // 若 root_token 为空，自动生成一个
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![get_backend_url, get_auth_token])
        .setup(|app| {
            let app_data_dir = app
                .path()
                .data_dir()
                .expect("failed to get data dir")
                .join("GtGroup")
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
            let sidecar_path = exe_dir.join("ai-gateway-backend");
            // resource 文件在 .app/Contents/Resources/resource/ 下
            let resource_dir = exe_dir.join("../Resources/resource");

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
            let mut cmd = std::process::Command::new(&sidecar_path);
            cmd.env("DB_PATH", db_path.to_str().unwrap())
               .env("PORT", config.port.to_string())
               .env("HOST", &config.host)
               .env("LOG_DIR", log_dir.to_str().unwrap())
               .env("ROOT_TOKEN", &config.root_token)
               .env("DESKTOP_MODE", "1")
               .env("MIGRATION_DIR", resource_dir.join("migrate").to_str().unwrap());

            // pre_exec：在 fork 之后、exec 之前在子进程中执行
            unsafe {
                cmd.pre_exec(move || {
                    // 1. 创建新 session，脱离父进程的进程组
                    libc::setsid();

                    // 2. 将 PTY slave 设为该 session 的控制终端
                    libc::ioctl(slave_raw, libc::TIOCSCTTY as u64, 0);

                    // 3. stdin 保持 slave（维持控制终端关系），stdout/stderr 指向 /dev/null
                    //    这样 backend 写日志不会填满 PTY 缓冲区，也不需要 drain 线程
                    libc::dup2(slave_raw, 0);
                    let devnull = libc::open(b"/dev/null\0".as_ptr() as *const _, libc::O_RDWR);
                    if devnull >= 0 {
                        libc::dup2(devnull, 1);
                        libc::dup2(devnull, 2);
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

            cmd.spawn().expect("failed to spawn backend sidecar");

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

            let tray_icon = Image::from_path(
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("icons/tray-icon@2x.png"),
            )
            .unwrap_or_else(|_| app.default_window_icon().unwrap().clone());

            TrayIconBuilder::new()
                .icon(tray_icon)
                .tooltip("AI Gateway")
                .menu(&menu)
                .menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
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
                    "open_config" => {
                        let dir = app.state::<std::path::PathBuf>().inner().clone();
                        let _ = open::that(dir);
                    }
                    "quit" => {
                        app.exit(0);
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
        .run(|_app_handle, event| match event {
            tauri::RunEvent::ExitRequested { api, .. } => {
                // Prevent the app from completely exiting when the last window closes
                api.prevent_exit();
            }
            _ => {}
        });
}
