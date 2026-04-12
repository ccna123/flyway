const API_BASE = import.meta.env.VITE_API_BASE || ''
const MOCK     = import.meta.env.VITE_MOCK === 'true'

// ── Mock data ────────────────────────────────────────────────────────────────
let _mockTaskStatus = 'STOPPED'
let _mockFiles = []
let _mockHistory = []
let _mockExec = {}

async function delay(ms = 400) { return new Promise(r => setTimeout(r, ms)) }

async function mockCall(path, method = 'GET', body = null) {
  await delay()
  // ECS control
  if (path === '/task/status') return { status: _mockTaskStatus, url: _mockTaskStatus === 'RUNNING' ? 'http://localhost:5000' : null }
  if (path === '/task/start')  { _mockTaskStatus = 'STARTING'; setTimeout(() => { _mockTaskStatus = 'RUNNING' }, 6000); return { ok: true } }
  if (path === '/task/stop')   { _mockTaskStatus = 'STOPPING'; setTimeout(() => { _mockTaskStatus = 'STOPPED' }, 4000); return { ok: true } }
  // App meta (env mode only)
  if (path === '/api/config')  return { env_mode: 'local', release: false }
  // Files
  if (path === '/api/files' && method === 'GET') return { files: _mockFiles }
  if (path === '/api/upload' && method === 'POST') {
    const file = { filename: 'V1__test.sql', size: 512, parsed: { version: 'V1', raw_version: '1', description: 'test' } }
    _mockFiles = [file]
    return { uploaded: ['V1__test.sql'], errors: [] }
  }
  if (path === '/api/files/delete' && method === 'POST') { _mockFiles = []; return { success: true, deleted: [] } }
  if (path.startsWith('/api/files/') && method === 'DELETE') { _mockFiles = _mockFiles.filter(f => !path.includes(f.filename)); return { success: true } }
  // Migration
  if (path === '/api/migrate' && method === 'POST') {
    const id = 'mock-' + Date.now()
    _mockExec[id] = { status: 'RUNNING', logs: [], startedAt: new Date().toISOString() }
    setTimeout(() => {
      _mockExec[id].status = 'SUCCESS'
      _mockExec[id].finishedAt = new Date().toISOString()
      _mockExec[id].logs = [
        { level: 'INFO', timestamp: new Date().toISOString(), message: 'Flyway Community Edition' },
        { level: 'INFO', timestamp: new Date().toISOString(), message: 'Successfully applied 1 migration' },
      ]
      _mockHistory.unshift({ executionId: id, version: body?.version || 'latest', status: 'SUCCESS', startedAt: _mockExec[id].startedAt, finishedAt: _mockExec[id].finishedAt })
    }, 4000)
    return { executionId: id }
  }
  if (path === '/api/migrate/staging' && method === 'POST') {
    const id = 'stg-' + Date.now()
    _mockExec[id] = { status: 'RUNNING', logs: [] }
    setTimeout(() => { _mockExec[id].status = 'SUCCESS'; _mockExec[id].logs = [{ level: 'INFO', timestamp: new Date().toISOString(), message: 'Staging migration OK' }] }, 3000)
    return { executionId: id }
  }
  if (path.startsWith('/api/migrate/status/')) {
    const id = path.split('/').pop()
    return _mockExec[id] || { status: 'FAILED', errorMessage: 'Not found' }
  }
  if (path === '/api/migrate/history') return { migrations: _mockHistory }
  if (path === '/api/test-connection' && method === 'POST') return { success: true, message: 'Connection OK ✓' }
  if (path === '/api/s3/files') return { files: [], error: null }
  // Dev tools
  if (path === '/api/dev/clear' && method === 'POST') { _mockFiles = []; _mockHistory = []; return { success: true, message: 'Cleared.' } }
  if (path === '/api/dev/seed' && method === 'POST') return { success: true, message: 'Seeded 1 user' }
  if (path === '/api/dev/update' && method === 'POST') return { success: true, message: 'Updated user' }
  if (path === '/api/dev/query' && method === 'POST') return { success: true, rows: [{ id: 1, name: 'Test User', email: 'test@example.com' }] }
  return { error: 'Mock: unknown route ' + path }
}

// ── Real fetch ───────────────────────────────────────────────────────────────
async function realCall(path, method = 'GET', body = null, isFormData = false) {
  const apiKey = localStorage.getItem('ecs_api_key') || ''
  const opts = { method, headers: { 'x-api-key': apiKey } }
  if (body && !isFormData) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
  if (body && isFormData)  { opts.body = body }
  const res = await fetch(`${API_BASE}${path}`, opts)
  if (res.status === 403) throw new Error('FORBIDDEN')
  return res.json()
}

// ── Public API ───────────────────────────────────────────────────────────────
export async function call(path, method = 'GET', body = null, isFormData = false) {
  return MOCK ? mockCall(path, method, body) : realCall(path, method, body, isFormData)
}

// ECS task control
export const taskStatus = ()         => call('/task/status')
export const taskStart  = ()         => call('/task/start', 'POST')
export const taskStop   = ()         => call('/task/stop',  'POST')

// App meta (env_mode, release only)
export const getConfig  = ()         => call('/api/config')

// Files
export const listFiles   = ()        => call('/api/files')
export const deleteFile  = (name)    => call(`/api/files/${encodeURIComponent(name)}`, 'DELETE')
export const deleteFiles = (files)   => call('/api/files/delete', 'POST', { files })
export const uploadFiles = (formData)=> call('/api/upload', 'POST', formData, true)

// Migration — db config passed in body
export const startMigration = (version, db)        => call('/api/migrate',         'POST', { version, db })
export const startStaging   = (version, stagingDb) => call('/api/migrate/staging', 'POST', { version, staging_db: stagingDb })
export const pollStatus     = (id)                 => call(`/api/migrate/status/${id}`)
export const getHistory     = ()                   => call('/api/migrate/history')
export const testConnection = (cfg)                => call('/api/test-connection', 'POST', cfg)

// S3
export const listS3Files    = ()        => call('/api/s3/files')
export const uploadToS3     = (files)   => call('/api/s3/upload',    'POST', { files })
export const downloadFromS3 = (files)   => call('/api/s3/download',  'POST', { files })

// Dev tools — db config passed in body
export const devClear  = (db) => call('/api/dev/clear',  'POST', { db })
export const devSeed   = (db) => call('/api/dev/seed',   'POST', { db })
export const devUpdate = (db) => call('/api/dev/update', 'POST', { db })
export const devQuery  = (db) => call('/api/dev/query',  'POST', { db })
