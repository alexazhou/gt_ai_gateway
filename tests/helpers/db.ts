import { join } from 'path'
import { readdirSync, readFileSync, existsSync } from 'fs'
import Database from 'better-sqlite3'
import { DB_CONFIG } from '../config'

const MIGRATION_DIR = join(process.cwd(), 'resource', 'migrate')

let db: Database.Database | null = null

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

  // Run migrations
  await runMigrations(db)

  console.log('Test database initialized successfully')
}

/**
 * Run database migrations
 */
async function runMigrations(database: Database.Database): Promise<void> {
  // Create migrations table if not exists
  database.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    )
  `)

  // Get applied migrations
  const appliedRows = database.prepare('SELECT name FROM _migrations ORDER BY name').all()
  const appliedNames = new Set((appliedRows as any[]).map((row: any) => row.name))

  // Get available migration files
  let available: string[] = []
  if (existsSync(MIGRATION_DIR)) {
    available = readdirSync(MIGRATION_DIR).filter((f) => f.endsWith('.sql'))
  }

  // Filter and sort migration files
  const validFiles = available.filter((f) => /(\d{4})\.sql$/.test(f)).sort()

  // Get pending migrations
  const pendingMigrations = validFiles.filter((name) => !appliedNames.has(name))

  console.log(`  Applied: ${appliedNames.size}, Available: ${validFiles.length}, Pending: ${pendingMigrations.length}`)

  if (pendingMigrations.length === 0) {
    console.log('Database is up to date.')
    return
  }

  // Apply pending migrations
  for (const file of pendingMigrations) {
    console.log(`  Applying migration: ${file}...`)
    const sqlPath = join(MIGRATION_DIR, file)
    const sql = readFileSync(sqlPath, 'utf-8')

    try {
      database.exec(sql)
      database.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file)
      console.log(`  ✅ Successfully applied: ${file}`)
    } catch (e) {
      console.error(`  ❌ Failed to apply migration ${file}:`, e)
      throw e
    }
  }

  console.log('All pending migrations applied.')
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
  if (!db) {
    console.log('Database not initialized, nothing to truncate')
    return
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
