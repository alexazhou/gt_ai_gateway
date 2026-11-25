use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::Arc;
use std::time::Duration;

/// config.json 缺省或取值非法时适用的日志级别
pub const DEFAULT_LOG_LEVEL: &str = "info";

/// 归一化日志级别：大小写不敏感，只接受 debug / info / warn / error，其余返回 None。
pub fn normalize_log_level(raw: &str) -> Option<String> {
    let value = raw.trim().to_ascii_lowercase();
    match value.as_str() {
        "debug" | "info" | "warn" | "error" => Some(value),
        _ => None,
    }
}

/// 解析桌面端数据目录：返回 Ok(None) 表示用系统默认目录。
///
/// 显式指定时**必须已存在且是目录**：自定义目录通常是挂载盘或准备好的工作区，
/// 路径不存在往往意味着拼写错误或外置盘没挂上，静默建空库比报错更危险。
pub fn resolve_custom_data_dir(
    raw: Option<&str>,
    home_dir: Option<&Path>,
) -> Result<Option<PathBuf>, String> {
    let raw = match raw {
        Some(value) if !value.trim().is_empty() => value.trim(),
        _ => return Ok(None),
    };

    let expanded: PathBuf = if raw == "~" || raw.starts_with("~/") {
        let home = match home_dir {
            Some(dir) => dir.to_path_buf(),
            None => return Err(format!("无法展开 ~：取不到用户主目录（GT_AI_GATEWAY_DATA_DIR={raw}）")),
        };
        if raw == "~" {
            home
        } else {
            home.join(&raw[2..])
        }
    } else {
        PathBuf::from(raw)
    };

    if !expanded.exists() {
        return Err(format!("GT_AI_GATEWAY_DATA_DIR 指向的目录不存在：{}", expanded.display()));
    }
    if !expanded.is_dir() {
        return Err(format!("GT_AI_GATEWAY_DATA_DIR 指向的不是目录：{}", expanded.display()));
    }

    Ok(Some(expanded))
}

pub fn generate_client_url(host: &str, port: u16) -> String {
    let client_host = if host == "0.0.0.0" {
        "127.0.0.1"
    } else {
        host
    };
    format!("http://{}:{}", client_host, port)
}

/// 子进程 stdio 的来源流
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StdioStream {
    Stdout,
    Stderr,
}

impl StdioStream {
    /// 日志前缀用的大写名（STDOUT / STDERR）
    pub fn label(self) -> &'static str {
        match self {
            StdioStream::Stdout => "STDOUT",
            StdioStream::Stderr => "STDERR",
        }
    }
}

/// 子进程被接成管道的 stdio 上发生的事件
#[derive(Debug)]
pub enum StdioEvent {
    /// 该路的读取线程已启动
    ReaderStarted(StdioStream),
    /// 读到一行（末尾换行已去掉）
    Line(StdioStream, String),
    /// 读取出错。只上报，读取循环不会因此结束
    ReadError(StdioStream, String),
    /// 该路已读到 EOF
    ReaderFinished(StdioStream),
    /// 子进程已退出，值为退出码
    Exited(i32),
}

/// 接管子进程被接成管道的 stdout / stderr，并等待子进程退出。
///
/// **被接成管道的 stdio 必须有人读**：无人读取时，子进程写满该管道缓冲区（Windows 上默认约
/// 64 KiB）后就会阻塞在写上；而 Node.js 在 Windows 上对管道是同步写，会直接卡死它的主线程，
/// 此后该进程不再响应任何请求。因此两路的读取循环都只在读到 EOF 时结束，中途读取出错只上报、不退出。
pub fn watch_piped_stdio<P>(child: Child, on_event: P)
where
    P: Fn(StdioEvent) + Send + Sync + 'static,
{
    let mut child = child;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let on_event = Arc::new(on_event);

    if let Some(stderr) = stderr {
        let on_event = Arc::clone(&on_event);
        std::thread::spawn(move || read_lines(stderr, StdioStream::Stderr, &*on_event));
    }

    std::thread::spawn(move || {
        if let Some(stdout) = stdout {
            read_lines(stdout, StdioStream::Stdout, &*on_event);
        }
        // stdout 结束意味着子进程已经退出
        if let Ok(status) = child.wait() {
            on_event(StdioEvent::Exited(status.code().unwrap_or(1)));
        }
    });
}

/// 逐行读取一路管道，直到 EOF。除进程退出外绝不停下，否则写端会重新被阻塞。
fn read_lines<P>(reader: impl Read, stream: StdioStream, on_event: &P)
where
    P: Fn(StdioEvent),
{
    on_event(StdioEvent::ReaderStarted(stream));

    let mut reader = BufReader::new(reader);
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        // 用 read_until 而非 BufRead::lines()：非 UTF-8 字节在 lines() 下会整行丢失
        match reader.read_until(b'\n', &mut buffer) {
            Ok(0) => break,
            Ok(_) => on_event(StdioEvent::Line(
                stream,
                String::from_utf8_lossy(&buffer).trim_end().to_string(),
            )),
            Err(e) => {
                on_event(StdioEvent::ReadError(stream, e.to_string()));
                // 出错也不结束循环：一旦停下，该管道会重新变成无人消费的写端
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }

    on_event(StdioEvent::ReaderFinished(stream));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!("gt-gateway-test-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn normalize_log_level_accepts_known_levels_case_insensitively() {
        assert_eq!(normalize_log_level("DEBUG").as_deref(), Some("debug"));
        assert_eq!(normalize_log_level("Info").as_deref(), Some("info"));
        assert_eq!(normalize_log_level(" warn ").as_deref(), Some("warn"));
        assert_eq!(normalize_log_level("error").as_deref(), Some("error"));
    }

    #[test]
    fn normalize_log_level_rejects_unknown_values() {
        assert_eq!(normalize_log_level("verbose"), None);
        assert_eq!(normalize_log_level(""), None);
        assert_eq!(normalize_log_level("   "), None);
    }

    #[test]
    fn resolve_custom_data_dir_returns_none_for_empty_values() {
        assert!(resolve_custom_data_dir(None, None).unwrap().is_none());
        assert!(resolve_custom_data_dir(Some(""), None).unwrap().is_none());
        assert!(resolve_custom_data_dir(Some("   "), None).unwrap().is_none());
    }

    #[test]
    fn resolve_custom_data_dir_accepts_existing_directory() {
        let dir = temp_dir("existing");
        let resolved = resolve_custom_data_dir(Some(dir.to_str().unwrap()), None).unwrap();
        assert_eq!(resolved.as_deref(), Some(dir.as_path()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_custom_data_dir_expands_tilde() {
        let home = temp_dir("home");
        let resolved = resolve_custom_data_dir(Some("~"), Some(&home)).unwrap();
        assert_eq!(resolved.as_deref(), Some(home.as_path()));

        let nested = home.join("data");
        std::fs::create_dir_all(&nested).unwrap();
        let resolved = resolve_custom_data_dir(Some("~/data"), Some(&home)).unwrap();
        assert_eq!(resolved.as_deref(), Some(nested.as_path()));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn resolve_custom_data_dir_rejects_missing_path() {
        let dir = temp_dir("missing").join("not-created");
        let err = resolve_custom_data_dir(Some(dir.to_str().unwrap()), None).unwrap_err();
        assert!(err.contains("不存在"), "错误信息应说明目录不存在：{err}");
    }

    #[test]
    fn resolve_custom_data_dir_rejects_file_path() {
        let dir = temp_dir("file");
        let file = dir.join("config.json");
        std::fs::write(&file, "{}").unwrap();
        let err = resolve_custom_data_dir(Some(file.to_str().unwrap()), None).unwrap_err();
        assert!(err.contains("不是目录"), "错误信息应说明不是目录：{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
