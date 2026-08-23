import { sutando } from "sutando";
import { DatabaseAdapter, D1Adapter, SQLiteAdapter, MySQLAdapter } from "../util/dbAdapterUtil";
import { MySQLDBAdapter } from "../util/db/mysqlDBAdapter";
import { SQLiteDBAdapter } from "../util/db/sqliteDBAdapter";
import dbMigrationService from "./dbMigrationService";
import customError from "../customError";
import { RunMode } from "../constants";

interface ORMOptions {
    mode: RunMode;
    dbPath?: string;
}

class ORMService {
    private _dbAdapter: DatabaseAdapter | null = null;
    public mode: RunMode = RunMode.WORKER;

    async init(options: ORMOptions): Promise<DatabaseAdapter> {
        const { mode, dbPath } = options;
        this.mode = mode;

        if (mode === RunMode.WORKER) {
            this._dbAdapter = new D1Adapter();
        } else if (process.env.DB_DRIVER === "mysql") {
            // MySQL 分支：建立 sutando(mysql2) 连接 + 运行时 MySQLAdapter + 执行迁移
            const mysql = (await import("mysql2/promise")).default;
            const conn = dbMigrationService.mysqlConnFromEnv();

            const pool = mysql.createPool({
                ...conn,
                connectionLimit: 10,
                multipleStatements: true,
                charset: "utf8mb4",
                dateStrings: true,
            });

            sutando.addConnection({
                client: "mysql2",
                connection: {
                    ...conn,
                },
                // 静默 knex 对 mysql 不支持 .returning() 的警告（mysql 通过 insertId 取回自增 id，无需 returning）
                log: {
                    warn: () => {},
                    deprecate: () => {},
                    debug: () => {},
                },
                useNullAsDefault: true,
            });

            this._dbAdapter = new MySQLAdapter(pool);

            const migrateAdapter = new MySQLDBAdapter(conn);
            await dbMigrationService.migrate(migrateAdapter, "node");
            migrateAdapter.close();
        } else {
            if (!dbPath) {
                throw new customError.AppError("dbPath is required for node mode", 500);
            }
            const Database = (await import("better-sqlite3")).default;

            sutando.addConnection({
                client: "better-sqlite3",
                connection: {
                    filename: dbPath,
                },
                useNullAsDefault: true,
            });

            const db = new Database(dbPath);
            this._dbAdapter = new SQLiteAdapter(db);

            const migrateAdapter = new SQLiteDBAdapter(dbPath);
            await dbMigrationService.migrate(migrateAdapter, "node");
            migrateAdapter.close();
        }

        return this._dbAdapter;
    }

    private _workerConnected = false;
    private _connectPromise: Promise<void> | null = null;

    async connectWorker(db: any) {
        if (this._dbAdapter instanceof D1Adapter) {
            this._dbAdapter.setDB(db);
        }

        if (!this._workerConnected) {
            // 使用 Promise 锁防止并发请求重复初始化连接
            // 第一个请求创建 Promise，后续并发请求 await 同一个 Promise
            if (!this._connectPromise) {
                this._connectPromise = this._doConnectWorker(db);
            }
            await this._connectPromise;
        }

        // === 每次请求都更新 D1 binding ===
        //
        // Cloudflare Workers 中每个请求都有独立的 I/O 上下文，
        // env.DB（D1 binding）是 per-request 的。
        // 但 sutando/knex 在首次初始化时缓存了 Client_D1 实例，
        // 其中 d1Driver 指向第一个请求的 env.DB。
        // 后续并发请求如果复用这个 client，会触发：
        // "Cannot perform I/O on behalf of a different request"
        //
        // 解决方案：每次请求都将当前的 env.DB 更新到 Client_D1 实例上，
        // 确保 acquireRawConnection() 和 _query() 使用的是当前请求的 D1 binding。
        this._updateD1Binding(db);
    }

    private _updateD1Binding(db: any): void {
        try {
            const instance = (sutando as any).getInstance();
            const queryBuilder = instance.manager?.['default'];
            if (queryBuilder) {
                // QueryBuilder 是 Proxy，通过 connector 访问 Knex 实例
                const knexInstance = queryBuilder.connector;
                if (knexInstance?.client) {
                    knexInstance.client.d1Driver = db;
                    knexInstance.client.driver = db;
                }
            }
        } catch (e) {
            // 静默处理，避免更新失败影响请求
        }
    }

    private async _doConnectWorker(db: any): Promise<void> {
        const ClientD1 = (await import("knex-cloudflare-d1")).default;

        // === Cloudflare Workers 跨请求 I/O 修复 ===
        //
        // 【问题】Cloudflare Workers 中每个请求的 env.DB（D1 binding）有独立 I/O 上下文。
        // knex 内部使用 tarn.js 连接池缓存连接对象（acquireRawConnection 返回值），
        // 当并发请求从池中获取到其他请求创建的连接时会触发：
        // "Cannot perform I/O on behalf of a different request"
        //
        // 【解决方案】
        // 1. 覆盖 acquireConnection：绕过连接池，始终返回 this.d1Driver（当前请求的 env.DB）
        // 2. 覆盖 releaseConnection：无需归还到池中
        // 3. 在 _query 中使用 this.d1Driver 替代 connection 参数
        //
        // this.d1Driver 通过 _updateD1Binding() 在每次请求的 dbMiddleware 中更新。

        // 绕过连接池，始终使用当前请求的 D1 binding
        (ClientD1.prototype as any).acquireConnection = async function () {
            return (this as any).d1Driver;
        };

        (ClientD1.prototype as any).releaseConnection = async function () {
            return;
        };

        // Date 补丁 + 使用当前请求的 D1 binding
        // worker 模式的 knex-cloudflare-d1 不实现 _formatBindings()，
        // Date 对象直接传给 D1 bind() 会报错（只接受 string|number|null）
        const originalQuery = (ClientD1.prototype as any)._query;
        (ClientD1.prototype as any)._query = async function (connection: any, obj: any) {
            if (obj.bindings) {
                obj.bindings = obj.bindings.map((b: any) =>
                    b instanceof Date ? b.toISOString() : b
                );
            }
            // 始终使用 this.d1Driver 而非 connection 参数（可能来自过期的连接池）
            return originalQuery.call(this, (this as any).d1Driver, obj);
        };

        sutando.addConnection({
            client: ClientD1,
            connection: {
                database: db,
            },
            useNullAsDefault: true,
        });
        this._workerConnected = true;
    }

    async prepareDBConnection(db: any) {
        if (this.mode === RunMode.WORKER) {
            await this.connectWorker(db);
        }
    }

    get isNode(): boolean {
        return this.mode === RunMode.NODE;
    }

    get isWorker(): boolean {
        return this.mode === RunMode.WORKER;
    }

    get dbAdapter(): DatabaseAdapter {
        if (!this._dbAdapter) {
            throw new customError.AppError("ORMService not initialized", 500);
        }
        return this._dbAdapter;
    }

    getKnex(): any {
        const queryBuilder = (sutando as any).connection();
        return (queryBuilder as any).connector;
    }

    private static readonly EXPECTED_TABLES = [
        "client_config",
        "config",
        "model",
        "recharge_records",
        "record",
        "user",
        "vendor",
        "vendor_model"
    ];

    async verifySchema(): Promise<void> {
        try {
            if (!this._dbAdapter) return;

            // 按驱动选择列表业务表的 SQL：sqlite 用 sqlite_master，mysql 用 information_schema
            const isMysql = process.env.DB_DRIVER === "mysql";
            const tableSql = isMysql
                ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()"
                : "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'";

            const result = await this._dbAdapter.prepare(tableSql).all();

            // Handle different driver return formats (better-sqlite3/mysql return array, D1 returns { results: array })
            const rows = Array.isArray(result) ? result : (result as any).results || [];
            const actualTables = new Set(rows.map((row: any) => row.name));

            const missingTables = ORMService.EXPECTED_TABLES.filter(table => !actualTables.has(table));

            if (missingTables.length > 0) {
                console.error(`\x1b[31m[CRITICAL WARNING] Database schema verification failed! Missing expected tables: ${missingTables.join(", ")}\x1b[0m`);
            }
        } catch (e) {
            console.error("\x1b[31m[CRITICAL WARNING] Failed to verify database schema:\x1b[0m", e);
        }
    }
}

const ormService = new ORMService();

export default ormService;
