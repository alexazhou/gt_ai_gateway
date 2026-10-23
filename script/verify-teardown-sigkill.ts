/**
 * `#27` 反证：teardown 的「SIGTERM → 超时 → SIGKILL → 端口释放」链路**真的**有效吗？
 *
 * 背景：`tests/globalSetup.ts` 原来只 `child.kill("SIGTERM")` 杀 spawn 出来的 wrapper，
 * 而真正持 socket 的是它的 loader 子进程（`node --require …/tsx/dist/preflight.cjs … src/local.ts`）
 * → loader 变 `ppid=1` 孤儿，并且换到 5xxxx 临时端口继续活着。
 * 修法是「独立进程组 + `process.kill(-pid)`」，**但这个修法自己也会自称成功**（R5）：
 * 如果 server 忽略 SIGTERM，进程组 SIGTERM 就是空操作，必须靠超时升级 SIGKILL 才真死。
 *
 * 本脚本就是那个「能让它失败的实验」，全部是实测、不猜：
 *   1. 起一个**故意忽略 SIGTERM** 的 HTTP server（用 `npx tsx` 起，和真门一样是 wrapper+loader 两层）；
 *   2. 对**进程组**发 SIGTERM，等 3s → 断言它**仍然活着**（证明 stub 真的忽略了 SIGTERM，
 *      否则这个反证是假的：杀得掉的东西证明不了降级链路）；
 *   3. 升级 SIGKILL → 轮询断言进程组消失 + 端口释放（≤3s）。
 *
 * 退出码：0 = 链路有效（PASS）；1 = 链路无效（FAIL，逐项打印失败原因）。
 *
 * 用法：`npx tsx script/verify-teardown-sigkill.ts`
 */
import { spawn, execSync } from "node:child_process";
import net from "node:net";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PORT = 9731; // 不占 9720/9999，可与门并行跑
const GRACEFUL_WAIT_MS = 3000;
const KILL_WAIT_MS = 3000;

function log(msg: string): void {
    console.log(`[t27-reverse] ${msg}`);
}

function portBusy(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.once("error", (e: any) => resolve(e?.code === "EADDRINUSE"));
        srv.once("listening", () => srv.close(() => resolve(false)));
        srv.listen(port, "127.0.0.1");
    });
}

async function waitPortState(port: number, wantBusy: boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
        const busy = await portBusy(port);
        if (busy === wantBusy) return true;
        await new Promise((r) => setTimeout(r, 100));
    } while (Date.now() < deadline);
    return false;
}

/** 进程组是否还活着（负 PID + signal 0 = 只探测不投递） */
function groupAlive(pgid: number): boolean {
    try {
        process.kill(-pgid, 0);
        return true;
    } catch {
        return false;
    }
}

function killGroup(pgid: number, signal: NodeJS.Signals): void {
    try {
        process.kill(-pgid, signal);
    } catch (e: any) {
        log(`kill(-${pgid}, ${signal}) 抛错：${e?.code ?? e?.message}`);
    }
}

function residual(pgid: number): string[] {
    try {
        const out = execSync("ps -Ao pid,ppid,pgid,command", { encoding: "utf8" });
        return out
            .split("\n")
            .filter((l) => {
                const cols = l.trim().split(/\s+/);
                return cols[2] === String(pgid) && cols[0] !== String(process.pid);
            })
            .slice(0, 8)
            .map((l) => l.trim());
    } catch {
        return [];
    }
}

async function main(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "t27-"));
    const stubPath = join(dir, "stubborn-server.ts");
    writeFileSync(
        stubPath,
        `import http from "node:http";
// 故意忽略 SIGTERM：模拟「优雅关闭永远等不到」的真实故障形态
process.on("SIGTERM", () => { console.log("[STUBBORN] SIGTERM ignored, still alive pid=" + process.pid); });
http.createServer((_q, r) => r.end("ok")).listen(${PORT}, "127.0.0.1", () => {
    console.log("[STUBBORN] READY pid=" + process.pid);
});
setInterval(() => {}, 1 << 30);
`,
        "utf8",
    );

    log(`起 stubborn server：npx tsx ${stubPath}（port ${PORT}）`);
    const child = spawn("npx", ["tsx", stubPath], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true, // 与 tests/globalSetup.ts 修法一致：独立进程组
        env: { ...process.env },
    });
    child.stdout?.on("data", (d) => log(`[stdout] ${String(d).trim()}`));
    child.stderr?.on("data", (d) => log(`[stderr] ${String(d).trim()}`));

    const pgid = child.pid ?? -1;
    if (pgid <= 0) {
        console.error("[t27-reverse] FAIL：拿不到 pid，无法验证");
        process.exit(1);
    }
    log(`进程组 pgid=${pgid}`);

    const failures: string[] = [];

    if (!(await waitPortState(PORT, true, 15000))) {
        console.error(`[t27-reverse] FAIL：server 没在 15s 内开始监听 ${PORT}`);
        killGroup(pgid, "SIGKILL");
        process.exit(1);
    }
    log(`✅ 步骤 1：server 已在 ${PORT} 监听（wrapper pid=${pgid}，另有 loader 子进程）`);

    // 步骤 2：进程组 SIGTERM —— 必须**杀不死**（这个 stub 忽略 SIGTERM）
    log("步骤 2：对进程组发 SIGTERM，等 3s");
    killGroup(pgid, "SIGTERM");
    await new Promise((r) => setTimeout(r, GRACEFUL_WAIT_MS));

    const aliveAfterTerm = groupAlive(pgid);
    const portBusyAfterTerm = await portBusy(PORT);
    if (aliveAfterTerm && portBusyAfterTerm) {
        log(`✅ 步骤 2：SIGTERM 果然无效（进程组仍活、${PORT} 仍被占）—— 反证前提成立`);
    } else {
        failures.push(
            `SIGTERM 后 stub 竟然死了（alive=${aliveAfterTerm}, portBusy=${portBusyAfterTerm}）：本反证不成立，换一个真的忽略 SIGTERM 的 stub`,
        );
        console.error(`[t27-reverse] FAIL：${failures[failures.length - 1]}`);
    }

    // 步骤 3：升级 SIGKILL —— 必须真的清干净
    log("步骤 3：升级 SIGKILL，等 3s");
    killGroup(pgid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 500));

    const portReleased = await waitPortState(PORT, false, KILL_WAIT_MS);
    const dead = !groupAlive(pgid);
    if (dead && portReleased) {
        log(`✅ 步骤 3：SIGKILL 后进程组消失且 ${PORT} 已释放`);
    } else {
        const lines = residual(pgid);
        failures.push(
            `SIGKILL 未清干净（进程组存活=${!dead}，端口仍占=${!portReleased}）` +
                (lines.length ? ` 残留：\n    ${lines.join("\n    ")}` : ""),
        );
        console.error(`[t27-reverse] FAIL：${failures[failures.length - 1]}`);
    }

    // 兜底：无论成败都把可能残留的清掉（本脚本自己的进程，不碰别人的）
    if (groupAlive(pgid)) {
        killGroup(pgid, "SIGKILL");
    }

    if (failures.length === 0) {
        console.log("\n[t27-reverse] PASS：SIGTERM（无效）→ 升级 SIGKILL → 进程组消失 + 端口释放，链路成立");
        process.exit(0);
    }
    console.log(`\n[t27-reverse] FAIL：${failures.length} 项不成立`);
    process.exit(1);
}

main().catch((e) => {
    console.error(`[t27-reverse] 异常：${e?.message ?? e}`);
    process.exit(1);
});
