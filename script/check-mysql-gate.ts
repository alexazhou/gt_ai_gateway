/**
 * 本地 MySQL 门（T7）前置检查 —— 「连不上就明确失败」，禁止静默回退 sqlite
 *
 * 存在理由：`backend:test:node:mysql` 在 DB_DRIVER=mysql 但 3306 不通时，
 * 很容易变成「一堆测试莫名失败」或者更糟——「看起来绿了」（实际跑的是 sqlite）。
 * 那与 #22 的假绿是同一个东西：**绿得没有意义，比红更危险**。
 *
 * 规则（#25 硬要求 1）：DB_DRIVER=mysql 但连不上 → **直接 exit 1**，打印
 *   ① 脱敏连接串 ② DB_DRIVER ③ 引擎探测结果 ④ 起容器命令。
 *
 * 引擎探测也在这里做（#25 硬要求 2 的第一条）：
 *   `SELECT version()` 必须成功 —— 证明连的是 MySQL 协议引擎，不是别的东西。
 *   （反向的 `SELECT sqlite_version()` 必须抛错，放在 tests/unit/db/mysqlGateHeartbeat.test.ts 用例里，
 *     因为那是「用例层反证」，属于被测面；这里是「入场券」。）
 *
 * 用法：`npx tsx script/check-mysql-gate.ts`（通常由 npm run test:mysql 先行调用）
 */
import config from "../tests/config";

const COMPOSE_CMD = "docker compose -f docker-compose.test-mysql.yml up -d";

function mask(conn: { user: string; password: string; host: string; port: number; database: string }): string {
    const pwd = conn.password ? "***" : "";
    const auth = conn.password ? `${conn.user}:${pwd}` : conn.user;
    return `mysql://${auth}@${conn.host}:${conn.port}/${conn.database}`;
}

async function main(): Promise<void> {
    const driver = config.DB_CONFIG.driver;
    const conn = config.DB_CONFIG.mysql;
    const masked = mask(conn);

    console.log("=== MySQL 门前置检查 ===");
    console.log(`DB_DRIVER   : ${driver}`);
    console.log(`连接串（脱敏）: ${masked}`);
    if (!conn.password) {
        // 常见坑：tests/config.ts 的 DB_PASSWORD 缺省是空串，而 compose 里的 root 密码是 rootpass。
        // 直接手工跑 tsx/vitest 而不带 DB_PASSWORD 时，得到的是 ER_ACCESS_DENIED_ERROR ——
        // 那看起来像「MySQL 坏了」，实际只是「密码没传」。
        console.log(`提示        : 当前未设置 DB_PASSWORD（tests/config.ts 缺省为空串）；本门容器默认 root/rootpass，`);
        console.log(`              用 npm run test:mysql 会自动带 DB_PASSWORD=rootpass。`);
    }

    if (driver !== "mysql") {
        console.error(`\n[FATAL] DB_DRIVER=${driver}，但本门只在 mysql 方言下有意义。`);
        console.error(`        请用 npm run test:mysql（它会把 DB_DRIVER 设为 mysql）而不是直接跑 vitest。`);
        process.exit(1);
    }

    let mysql: any;
    try {
        mysql = await import("mysql2/promise");
    } catch (e: any) {
        console.error(`\n[FATAL] 无法加载 mysql2/promise: ${e?.message ?? e}`);
        console.error(`        依赖缺失请先 npm ci（或确认 node_modules 已就绪）。`);
        process.exit(1);
    }

    let version = "";
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
        await pool.end();
    } catch (e: any) {
        console.error(`\n[FATAL] 连不上 MySQL：${e?.code ?? ""} ${e?.message ?? e}`);
        console.error(`        引擎探测（SELECT version()）: 失败`);
        console.error(`        连接串（脱敏）           : ${masked}`);
        console.error(`\n请先起容器（与 CI 同参数：root/rootpass + DB=test + 3306）：`);
        console.error(`        ${COMPOSE_CMD}`);
        console.error(`        等健康检查通过（mysqladmin ping）后再跑。`);
        console.error(`\n注意：本门【不会】回退 sqlite。回退得到的绿是假绿——`);
        console.error(`      正是 #22 里「本地全绿 / CI MySQL 连红 10/10」的成因。`);
        process.exit(1);
    }

    console.log(`引擎探测（SELECT version()）: OK → ${version}`);
    console.log("=== 前置检查通过，开始跑 MySQL 门 ===\n");
}

main().catch((e) => {
    console.error(`[FATAL] 前置检查异常: ${e?.message ?? e}`);
    process.exit(1);
});
