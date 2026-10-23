/**
 * 本地 MySQL 门（T7）前置检查 —— 五态预检，文案分开
 *
 * 为什么不是「只探 MySQL」：门的失败有**五种完全不同**的病因，全都以 exit 1 结束。
 * 如果只有一句「MySQL 门跑不起来」，下一个人会把「端口被别的门占了」误读成「MySQL 坏了」，
 * 然后再花半小时排查一个不存在的问题（本项目已经为这类错归因付过多次代价）。
 *
 *   ① 9999 被占   → mock 上游端口被占：另一个 vitest 门在跑（`tests/config.ts:142` → `globalSetup.ts:102`）
 *   ② 9720 被占   → 被测服务端口被占：残留 `tsx src/local.ts` / `wrangler dev`
 *                    （`startTestServer()` 在 `globalSetup.ts:122` **无条件**调用，node 模式也占 9720）
 *   ③ 3306 不通   → MySQL 未起（提示 compose 命令）
 *   ④ marker 缺失 → **连到的不是本次容器**（实例同一性：`SELECT version()` 证明不了这一条）
 *   ⑤ 全通        → 才允许跑门
 *
 * 实现约束（都踩过坑，别再改回去）：
 * - **不依赖 `docker` CLI 做归因**：`docker` 可能不在 PATH 里（实测：`/usr/local/bin/docker` + 精简 PATH
 *   → `command not found`）。docker 只出现在**提示文案**里，判断一律走驱动直连 / socket 探测。
 * - **端口探测用 node 的 `net` 自己 bind**，不用 `lsof`（同样可能不在 PATH，且解析输出易错）。
 * - **不信任注释**：`_t7_gate_marker` 的存在与否是唯一能区分「本次容器」与「本机别的 MySQL」的证据。
 * - **marker 必须放在测试库之外（`t7_gate` 库）**：`tests/helpers/dbHelper.ts` 的 `initDatabase()`
 *   在 MySQL 模式下开头就 `dropAllMysqlTables()`（**无条件** DROP `DATABASE()` 里的所有表）。
 *   marker 若跟测试表同库，第一跑建库时就被删 → 第二跑 ④ 会把「连对了容器」误报成「连错了实例」。
 *   这条是实测出来的（`c12bf61` 第二次跑即命中），不是预防性设计。
 */
import net from "node:net";
import { execSync } from "node:child_process";
import config from "../tests/config";

const COMPOSE_CMD = "docker compose -f docker-compose.test-mysql.yml up -d";
const APP_PORT = 9720; // tests/config.ts:21 TEST_PORT —— startTestServer() 无条件监听
const MOCK_PORT = 9999; // tests/config.ts:142 TEST_UPSTREAM_MOCK_URL 默认端口
const MARKER = "t7-local-mysql-gate";
// marker 在**独立库**里：测试初始化会 DROP 掉测试库里所有表（见文件头第 5 条约束）
const MARKER_DB = "t7_gate";
const MARKER_FQN = `${MARKER_DB}._t7_gate_marker`;

function mask(conn: { user: string; password: string; host: string; port: number; database: string }): string {
    const pwd = conn.password ? "***" : "";
    const auth = conn.password ? `${conn.user}:${pwd}` : conn.user;
    return `mysql://${auth}@${conn.host}:${conn.port}/${conn.database}`;
}

/** 端口是否已被占用（自己 bind 一次，PATH 无关、也不依赖 lsof 输出格式） */
function portBusy(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.once("error", (e: any) => resolve(e?.code === "EADDRINUSE"));
        srv.once("listening", () => srv.close(() => resolve(false)));
        srv.listen(port, "127.0.0.1");
    });
}

/** 找残留的测试服务进程（只报 PID，不杀 —— 杀进程不是前置检查的职责） */
function findLeftoverServers(): string[] {
    try {
        const out = execSync("ps -eo pid,command", { encoding: "utf8" });
        return out
            .split("\n")
            .filter((l) => /tsx src\/local\.ts|wrangler dev/.test(l) && !/ps -eo pid,command/.test(l))
            .map((l) => l.trim())
            .slice(0, 12);
    } catch {
        return [];
    }
}

async function main(): Promise<void> {
    const driver = config.DB_CONFIG.driver;
    const conn = config.DB_CONFIG.mysql;
    const masked = mask(conn);

    console.log("=== MySQL 门前置检查（五态）===");
    console.log(`DB_DRIVER   : ${driver}`);
    console.log(`连接串（脱敏）: ${masked}`);
    if (!conn.password) {
        console.log(`提示        : 未设置 DB_PASSWORD（tests/config.ts 缺省为空串）；本门容器默认 root/rootpass，`);
        console.log(`              npm run test:mysql 会自动带上 DB_PASSWORD=rootpass。`);
    }

    // ① DB_DRIVER
    if (driver !== "mysql") {
        console.error(`\n[FATAL-①] DB_DRIVER=${driver}，但本门只在 mysql 方言下有意义。`);
        console.error(`          请用 npm run test:mysql（它会把 DB_DRIVER 设为 mysql）而不是直接跑 vitest。`);
        process.exit(1);
    }

    // ② 端口 9999 / 9720（先查端口，再查 MySQL —— 端口问题最常见且最容易被错归因）
    const busy: string[] = [];
    if (await portBusy(MOCK_PORT)) busy.push(`9999（mock 上游，tests/config.ts:142）`);
    if (await portBusy(APP_PORT)) busy.push(`${APP_PORT}（被测服务，tests/config.ts:21 + globalSetup.ts:122）`);
    if (busy.length > 0) {
        console.error(`\n[FATAL-②] 测试端口被占用：${busy.join("；")}`);
        console.error(`          这**不是** MySQL 的问题 —— 是另一个测试门/残留服务还在跑。`);
        console.error(`          请先确认没有别的 vitest 在跑（团队约定用 \`npm run test:locked…\` 串行），再重试。`);
        const leftovers = findLeftoverServers();
        if (leftovers.length > 0) {
            console.error(`          检测到残留测试服务进程（**只列 PID，不代杀**，请确认归属后自行处理）：`);
            for (const l of leftovers) console.error(`            ${l}`);
        }
        process.exit(1);
    }

    // ③ 3306 连通 + ④ marker 实例身份
    let mysql: any;
    try {
        mysql = await import("mysql2/promise");
    } catch (e: any) {
        console.error(`\n[FATAL-③] 无法加载 mysql2/promise: ${e?.message ?? e}\n          依赖缺失请先 npm ci。`);
        process.exit(1);
    }

    let version = "";
    let marker = "";
    try {
        const pool = mysql.createPool({
            host: conn.host,
            port: conn.port,
            user: conn.user,
            password: conn.password,
            database: conn.database,
            connectionLimit: 1,
            connectTimeout: 5000,
        });
        const [rows] = await pool.query("SELECT version() AS v");
        version = String((rows as any[])[0]?.v ?? "");

        try {
            const [mrows] = await pool.query(`SELECT marker FROM ${MARKER_FQN} WHERE id = 1`);
            marker = String((mrows as any[])[0]?.marker ?? "");
        } catch (e: any) {
            await pool.end().catch(() => {});
            console.error(`\n[FATAL-④] 连上了 MySQL（${version || "版本未知"}），但读不到 ${MARKER_FQN}`);
            console.error(`          → 连到的**不是本次容器**（可能是本机已有的其它 MySQL 占着 3306）。`);
            console.error(`          连接串（脱敏）: ${masked}`);
            console.error(`          底层错误      : ${e?.code ?? ""} ${e?.message ?? e}`);
            console.error(`          处理（二选一）：`);
            console.error(`            a) 本机 3306 被别的 MySQL 占着 → 先停掉它；`);
            console.error(`            b) 容器是**旧数据卷**（init 脚本只在空卷上跑一次，marker 库/表不会自动重建）：`);
            console.error(`               docker compose -f docker-compose.test-mysql.yml down -v`);
            console.error(`               ${COMPOSE_CMD}`);
            process.exit(1);
        }
        await pool.end();
    } catch (e: any) {
        console.error(`\n[FATAL-③] 连不上 MySQL：${e?.code ?? ""} ${e?.message ?? e}`);
        console.error(`          引擎探测（SELECT version()）: 失败`);
        console.error(`          连接串（脱敏）           : ${masked}`);
        console.error(`\n          请先起容器（与 CI 同参数：root/rootpass + DB=test + 3306）：`);
        console.error(`            ${COMPOSE_CMD}`);
        console.error(`          等健康检查通过（mysqladmin ping）后再跑。`);
        console.error(`\n          注意：本门【不会】回退 sqlite。回退得到的绿是假绿——`);
        console.error(`                正是 #22 里「本地全绿 / CI MySQL 连红 10/10」的成因。`);
        process.exit(1);
    }

    if (marker !== MARKER) {
        console.error(`\n[FATAL-④] marker 值不符：期望 "${MARKER}"，实得 "${marker}"`);
        console.error(`          → 连到的是「某个 MySQL」，但不是本门的容器。拒绝继续（否则测的不是该测的东西）。`);
        process.exit(1);
    }

    console.log(`引擎探测（SELECT version()）: OK → ${version}`);
    console.log(`实例身份（${MARKER_FQN}）: OK → ${marker}`);
    console.log(`端口 ${MOCK_PORT}/${APP_PORT}          : 空闲`);
    console.log("=== 前置检查通过（全通），开始跑 MySQL 门 ===\n");
}

main().catch((e) => {
    console.error(`[FATAL] 前置检查异常: ${e?.message ?? e}`);
    process.exit(1);
});
