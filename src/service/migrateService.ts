import { ormService } from './ormService'
import fileService from './fileService'

const RESOURCE_DIR = 'src/resource/migrate'

export interface Migration {
  id?: number
  name: string
  applied_at?: string
}

// 从文件名提取版本号（.sql 前面的四位数字）
function extractVersion(name: string): number {
  const match = name.match(/(\d{4})\.sql$/)
  return match ? parseInt(match[1], 10) : 0
}

async function initMigrationsTable() {
  const dbAdapter = ormService.dbAdapter
  // 创建新表（不包含 version 字段）
  await dbAdapter.exec('CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)')
}

async function getAppliedMigrations(): Promise<Migration[]> {
  const dbAdapter = ormService.dbAdapter
  const result = await dbAdapter.prepare('SELECT name FROM _migrations ORDER BY name').all()
  if (result && 'results' in result) {
    return result.results as Migration[]
  }
  return (result || []) as Migration[]
}

async function getAppliedMigrationsWithDetails(): Promise<Migration[]> {
  await initMigrationsTable()
  const dbAdapter = ormService.dbAdapter
  const result = await dbAdapter.prepare('SELECT id, name, applied_at FROM _migrations ORDER BY name').all()
  if (result && 'results' in result) {
    return result.results as Migration[]
  }
  return (result || []) as Migration[]
}

async function getAvailableMigrations(): Promise<Migration[]> {
  const files = await fileService.listFiles(RESOURCE_DIR, '*.sql')

  console.log('getAvailableMigrations - RESOURCE_DIR:', RESOURCE_DIR)
  console.log('getAvailableMigrations - files:', files)

  // 过滤不符合规范的文件名并输出警告
  const validFiles: string[] = []
  for (const file of files) {
    const version = extractVersion(file)
    if (version > 0) {
      validFiles.push(file)
    } else {
      console.warn(`Warning: Migration file "${file}" does not match naming convention. Skipping.`)
    }
  }

  return validFiles.sort().map((file) => ({
    name: file
  }))
}

async function applyMigration(migration: Migration) {
  const dbAdapter = ormService.dbAdapter
  const sqlPath = `${RESOURCE_DIR}/${migration.name}`
  const sql = await fileService.readFile(sqlPath)

  console.log('applyMigration - sqlPath:', sqlPath)

  // D1 本地模式需要逐条执行 SQL
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0)

  for (const statement of statements) {
    // D1 的 exec() 按行解析 SQL，多行的 CREATE TABLE 等语句会失败
    // 将换行符替换为空格，确保每条语句为单行
    const singleLine = statement.replace(/\n/g, ' ')
    await dbAdapter.exec(singleLine + ';')
  }

  // 记录已应用的迁移
  await dbAdapter.prepare(
    'INSERT INTO _migrations (name) VALUES (?)'
  ).run(migration.name)

  console.log(`Applied migration: ${migration.name}`)
}

async function migrate(): Promise<number> {
  await initMigrationsTable()

  const applied = await getAppliedMigrations()
  const available = await getAvailableMigrations()

  const appliedNames = new Set(applied.map(m => m.name))
  const pendingMigrations = available.filter(m => !appliedNames.has(m.name))

  console.log('migrate - applied:', applied.length, 'available:', available.length, 'pending:', pendingMigrations.length)

  if (pendingMigrations.length === 0) {
    console.log('Database is up to date')
    return 0
  }

  console.log(`Found ${pendingMigrations.length} pending migration(s)`)

  for (const migration of pendingMigrations) {
    await applyMigration(migration)
  }

  return pendingMigrations.length
}

async function getCurrentVersion(): Promise<number> {
  await initMigrationsTable()
  const dbAdapter = ormService.dbAdapter
  const result = await dbAdapter.prepare('SELECT name FROM _migrations ORDER BY name DESC LIMIT 1').first()
  return result?.name ? extractVersion(result.name) : 0
}

export default {
  migrate,
  getCurrentVersion,
  getAppliedMigrations: getAppliedMigrationsWithDetails,
}
