import { join } from 'path'
import { spawn, ChildProcess } from 'child_process'
import { existsSync, unlinkSync } from 'fs'
import config, { DB_CONFIG, SERVER_CONFIG, TEST_OPTIONS, logTest } from './config'
import { init as initDB, cleanup as cleanupDB, truncate as truncateDB } from './helpers/dbHelper'
import { startMockServer, stopMockServer, isMockServerRunning } from './helpers/mockServer'

// Global state object that persists across all test files
;(global as any).__testSetupState = (global as any).__testSetupState || {
  testServerProcess: null,
  mockServerProcess: null,
  isSetupComplete: false,
  setupCount: 0,
}

const globalState = (global as any).__testSetupState

export async function globalSetup(): Promise<void> {
  globalState.setupCount++

  if (globalState.isSetupComplete) {
    logTest(`Global setup already complete (count: ${globalState.setupCount}), skipping...`)
    return
  }

  logTest('=== Test Environment Setup ===')

  cleanupTestDatabaseFile()

  logTest('Initializing test database...')
  await initDB()

  if (config.useMockServer && !isMockServerRunning()) {
    logTest('Starting mock AI server...')
    globalState.mockServerProcess = await startMockServer()
  }

  await startTestServer()

  globalState.isSetupComplete = true
  logTest('Test environment ready!')
}

export async function globalTeardown(): Promise<void> {
  globalState.setupCount--

  // Only teardown when all test files have completed
  if (globalState.setupCount > 0) {
    logTest('Still have active test files, skipping teardown')
    return
  }

  if (!globalState.isSetupComplete) {
    return
  }

  logTest('=== Test Environment Teardown ===')

  await stopTestServer()

  if (globalState.mockServerProcess) {
    await stopMockServer(globalState.mockServerProcess)
    globalState.mockServerProcess = null
  }

  if (TEST_OPTIONS.cleanup) {
    logTest('Cleaning up test database...')
    await cleanupDB()
    cleanupTestDatabaseFile()
  }

  globalState.isSetupComplete = false
  logTest('Test environment teardown complete!')
}

function startTestServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const serverPath = join(process.cwd(), 'src', 'local.ts')
    const env = {
      ...process.env,
      PORT: SERVER_CONFIG.port.toString(),
      DB_PATH: DB_CONFIG.path,
    }

    logTest('Starting test server on port', SERVER_CONFIG.port)
    logTest('Database path:', DB_CONFIG.path)

    globalState.testServerProcess = spawn('npx', ['tsx', serverPath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    if (TEST_OPTIONS.verbose) {
      globalState.testServerProcess.stdout?.on('data', (data) => {
        console.log('[SERVER]', data.toString().trim())
      })
      globalState.testServerProcess.stderr?.on('data', (data) => {
        console.error('[SERVER ERROR]', data.toString().trim())
      })
    }

    globalState.testServerProcess.on('error', (err) => {
      reject(err)
    })

    setTimeout(resolve, 5000)
  })
}

function stopTestServer(): Promise<void> {
  return new Promise((resolve) => {
    if (globalState.testServerProcess) {
      logTest('Stopping test server...')
      globalState.testServerProcess.kill('SIGTERM')
      globalState.testServerProcess = null
    }
    resolve()
  })
}

function cleanupTestDatabaseFile(): void {
  if (existsSync(DB_CONFIG.path)) {
    logTest('Removing test database file:', DB_CONFIG.path)
    unlinkSync(DB_CONFIG.path)
  }
}
