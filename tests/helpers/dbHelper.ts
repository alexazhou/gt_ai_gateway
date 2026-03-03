import { readdirSync, readFileSync, existsSync } from 'fs'
import Database from 'better-sqlite3'
import { DB_CONFIG } from '../config'
import { migrate as runMigrations, DBAdapter, Migration, MIGRATION_DIR } from '../../script/db'

let db: Database.Database | null = null

/**
 * LocalDBAdapter wrapper for test database
 */
class LocalDBAdapter implements DBAdapter {
    constructor(private db: Database.Database) {}

    exec(sql: string): void {
        this.db.exec(sql)
    }

    query<T>(sql: string): T[] {
        return this.db.prepare(sql).all() as T[]
    }

    run(sql: string, ...params: any[]): void {
        this.db.prepare(sql).run(...params)
    }

    close(): void {
        this.db.close()
    }
}

/**
 * Initialize test database with migrations
 */
export async function init(): Promise<void> {
    if (db) {
        console.log('Database already initialized')
        return
    }

    console.log('Initializing test database:', DB_CONFIG.path)

    // Create database
    db = new Database(DB_CONFIG.path)

    // Run migrations using the shared migration logic
    const adapter = new LocalDBAdapter(db)
    await runMigrations(adapter, 'test')

    console.log('Test database initialized successfully')
}

/**
 * Cleanup database - remove all data
 */
export async function cleanup(): Promise<void> {
    if (!db) {
        console.log('Database not initialized, nothing to cleanup')
        return
    }

    console.log('Cleaning up test database...')

    const tables = db
        .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' AND name != '_migrations'"
        )
        .all() as { name: string }[]

    for (const table of tables) {
        try {
            db.prepare(`DROP TABLE IF EXISTS ${table.name}`).run()
        } catch (e) {
            console.error(`Failed to drop table ${table.name}:`, e)
        }
    }

    console.log('Database cleaned up')
}

/**
 * Truncate tables - remove all data but keep structure
 */
export async function truncate(): Promise<void> {
    // Auto-connect if not initialized
    if (!db) {
        db = new Database(DB_CONFIG.path)
    }

    console.log('Truncating tables...')

    const tables = db
        .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' AND name != '_migrations'"
        )
        .all() as { name: string }[]

    for (const table of tables) {
        try {
            db.prepare(`DELETE FROM ${table.name}`).run()
        } catch (e) {
            console.error(`Failed to truncate table ${table.name}:`, e)
        }
    }

    console.log('Tables truncated')
}

/**
 * Execute raw SQL query
 */
export function query<T>(sql: string, params: any[] = []): T[] {
    if (!db) {
        throw new Error('Database not initialized')
    }

    try {
        return db.prepare(sql).all(...params) as T[]
    } catch (e) {
        console.error('Query failed:', sql, params, e)
        throw e
    }
}

/**
 * Execute raw SQL statement (insert, update, delete)
 */
export function execute(sql: string, params: any[] = []): Database.RunResult {
    if (!db) {
        throw new Error('Database not initialized')
    }

    try {
        return db.prepare(sql).run(...params)
    } catch (e) {
        console.error('Execute failed:', sql, params, e)
        throw e
    }
}

/**
 * Get database instance
 */
export function getDB(): Database.Database {
    if (!db) {
        throw new Error('Database not initialized')
    }
    return db
}

/**
 * Close database connection
 */
export function close(): void {
    if (db) {
        db.close()
        db = null
        console.log('Database connection closed')
    }
}
