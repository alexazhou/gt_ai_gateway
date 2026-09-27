use std::io::{BufRead, BufReader, Read};
use std::process::Child;
use std::sync::Arc;
use std::time::Duration;

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
