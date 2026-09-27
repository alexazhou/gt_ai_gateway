use ai_gateway_lib::utils::{watch_piped_stdio, StdioEvent, StdioStream};

use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 子进程灌多少行 stderr；每行 LINE_LEN 个字符加一个换行。
/// 总量需要远大于管道缓冲区（Windows 上约 64 KiB），否则写端不会阻塞。
const FLOOD_LINES: usize = 20_000;
const LINE_LEN: usize = 63;
const FLOOD_ENV: &str = "GT_TEST_STDERR_FLOOD_LINES";

/// 子进程角色：向 stderr 灌数据。由 stderr_is_fully_drained 通过 re-exec 本测试程序触发，
/// 直接运行时（没有环境变量）什么都不做。
#[test]
fn stderr_flood_writer() {
    let count = match std::env::var(FLOOD_ENV) {
        Ok(value) => value.parse::<usize>().unwrap_or(0),
        Err(_) => return,
    };

    let mut line = "x".repeat(LINE_LEN);
    line.push('\n');

    let stderr = std::io::stderr();
    let mut stderr = stderr.lock();
    for _ in 0..count {
        // 管道写满且无人读取时，这里会一直阻塞（Node.js 在 Windows 上对管道也是同步写）
        stderr.write_all(line.as_bytes()).expect("写入 stderr 失败");
    }
}

/// 后端进程的 stderr 是管道：一旦没有读取者，写满 64 KiB 后进程就会阻塞在写上（issue #26）。
/// 这里用「子进程灌 stderr，看它能否写完并退出、且数据被完整读走」钉住这条不变量。
#[test]
fn stderr_is_fully_drained() {
    let exe = std::env::current_exe().expect("无法定位测试程序自身路径");
    let child = Command::new(exe)
        .args(["--exact", "stderr_flood_writer"])
        .env(FLOOD_ENV, FLOOD_LINES.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("无法启动灌 stderr 的子进程");

    let received = Arc::new(Mutex::new(Vec::<String>::new()));
    let collected = Arc::clone(&received);
    let (exit_tx, exit_rx) = mpsc::channel();

    watch_piped_stdio(child, move |event| match event {
        StdioEvent::Line(StdioStream::Stderr, line) => collected.lock().unwrap().push(line),
        StdioEvent::Exited(code) => {
            let _ = exit_tx.send(code);
        }
        _ => {}
    });

    // 若 stderr 没有被消费，子进程会卡在写满的管道上，这里就会等到超时
    let code = exit_rx
        .recv_timeout(Duration::from_secs(30))
        .expect("子进程 30 秒内没有退出：stderr 管道没有被消费");

    let bytes: usize = received
        .lock()
        .unwrap()
        .iter()
        .map(|line| line.len())
        .sum();
    assert_eq!(code, 0, "子进程写入 stderr 失败，退出码 {}", code);
    assert!(
        bytes >= FLOOD_LINES * LINE_LEN,
        "stderr 没有被完整读取：收到 {} 字节，期望至少 {} 字节",
        bytes,
        FLOOD_LINES * LINE_LEN,
    );
}
