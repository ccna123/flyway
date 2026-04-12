import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { testConnection } from '../api.js'

export const STORAGE_KEY = 'flyway_config'

export const DEFAULT_CONFIG = {
  host: '',
  port: '5432',
  database: '',
  username: '',
  password: '',
  schema: 'public',
  s3_bucket: '',
  s3_region: 'ap-northeast-1',
  s3_prefix: 'flyway/',
  staging_host: '',
  staging_port: '',
  staging_db_name: '',
  staging_username: '',
  staging_password: '',
  staging_schema: '',
}

export function loadSavedConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    return { ...DEFAULT_CONFIG, ...saved }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(cfg) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg))
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function Field({ label, value, onChange, type = 'text', placeholder = '' }) {
  return (
    <div className="mb-3">
      <label className="block text-xs mb-1.5 font-medium" style={{ color: '#9ca3af' }}>{label}</label>
      <input
        type={type} value={value || ''} onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 rounded-lg text-sm outline-none font-mono"
        style={{ background: '#0d1117', border: '1px solid #21262d', color: '#d1d5db' }}
      />
    </div>
  )
}

function InlineField({ label, value, onChange, placeholder = '' }) {
  return (
    <div>
      <label className="block text-xs mb-1.5 font-medium" style={{ color: '#9ca3af' }}>{label}</label>
      <input
        value={value || ''} onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 rounded-lg text-sm font-mono outline-none"
        style={{ background: '#0d1117', border: '1px solid #21262d', color: '#d1d5db' }}
      />
    </div>
  )
}

function Card({ children, title, icon, accent }) {
  return (
    <div className="rounded-xl" style={{ background: '#161b22', border: `1px solid ${accent ? 'rgba(245,166,35,0.4)' : '#21262d'}` }}>
      <div className="flex items-center gap-2 px-4 py-3" style={{ borderBottom: '1px solid #21262d' }}>
        {icon}
        <span className="text-sm font-medium" style={{ color: accent || '#f0f6fc' }}>{title}</span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

function Btn({ children, onClick, disabled, style }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="px-3 py-1.5 rounded-lg text-xs font-medium hover:opacity-80 disabled:opacity-40 flex items-center gap-1.5"
      style={{ border: '1px solid #30363d', color: '#d1d5db', background: 'transparent', ...style }}>
      {children}
    </button>
  )
}

function TestResult({ result }) {
  if (!result) return null
  return (
    <div className="mt-2 px-3 py-2 rounded-lg flex items-center gap-2 text-xs"
      style={{ background: '#0d1117', border: `1px solid ${result.success ? '#3ecf8e' : '#f66070'}40` }}>
      <span style={{ color: result.success ? '#3ecf8e' : '#f66070' }}>{result.success ? '✓' : '✗'}</span>
      <span style={{ color: '#d1d5db' }}>{result.message}</span>
    </div>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────

export default function Settings() {
  const [cfg, setCfg] = useState(loadSavedConfig)
  const [savedFlash, setSavedFlash] = useState(false)
  const [dbResult, setDbResult] = useState(null)
  const [stgResult, setStgResult] = useState(null)
  const [testing, setTesting] = useState({ db: false, stg: false })
  const debounceRef = useRef(null)
  const isFirstRender = useRef(true)

  // Auto-save to localStorage 800ms after last change
  useEffect(() => {
    if (isFirstRender.current) { isFirstRender.current = false; return }
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      saveConfig(cfg)
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 1500)
    }, 800)
    return () => clearTimeout(debounceRef.current)
  }, [cfg])

  function set(key) {
    return val => setCfg(c => ({ ...c, [key]: val }))
  }

  function handleSave() {
    clearTimeout(debounceRef.current)
    saveConfig(cfg)
    setSavedFlash(true)
    setTimeout(() => setSavedFlash(false), 1500)
  }

  async function testDb() {
    setTesting(t => ({ ...t, db: true })); setDbResult(null)
    try {
      const d = await testConnection({
        host: cfg.host, port: cfg.port, database: cfg.database,
        username: cfg.username, password: cfg.password, schema: cfg.schema,
      })
      setDbResult(d)
    } catch (e) { setDbResult({ success: false, message: e.message }) }
    finally { setTesting(t => ({ ...t, db: false })) }
  }

  async function testStg() {
    if (!cfg.staging_host) return
    setTesting(t => ({ ...t, stg: true })); setStgResult(null)
    try {
      const d = await testConnection({
        host: cfg.staging_host,
        port: cfg.staging_port || cfg.port,
        database: cfg.staging_db_name || cfg.database,
        username: cfg.staging_username || cfg.username,
        password: cfg.staging_password || cfg.password,
        schema: cfg.staging_schema || cfg.schema,
      })
      setStgResult(d)
    } catch (e) { setStgResult({ success: false, message: e.message }) }
    finally { setTesting(t => ({ ...t, stg: false })) }
  }

  const DbIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3ecf8e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  )

  return (
    <div style={{ background: '#0f1117', minHeight: '100vh' }}>
      {/* Sidebar */}
      <div className="fixed left-0 top-0 h-full flex flex-col" style={{ width: 200, background: '#0d1117', borderRight: '1px solid #21262d' }}>
        <div className="px-4 py-4 flex items-center gap-2" style={{ borderBottom: '1px solid #21262d' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3ecf8e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <ellipse cx="12" cy="5" rx="9" ry="3" />
            <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
          </svg>
          <span className="font-semibold text-sm" style={{ color: '#f0f6fc' }}>FlywayOps</span>
        </div>
        <div className="px-3 py-3 flex-1">
          <Link to="/dashboard" className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm mb-0.5" style={{ color: '#6b7280' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
              <rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
            </svg>
            Dashboard
          </Link>
          <Link to="/settings" className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm" style={{ color: '#3ecf8e', background: 'rgba(62,207,142,0.08)' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.07 4.93l-1.41 1.41M4.93 4.93l1.41 1.41M19.07 19.07l-1.41-1.41M4.93 19.07l1.41-1.41M12 2v2M12 20v2M2 12h2M20 12h2" />
            </svg>
            Settings
          </Link>
        </div>
      </div>

      <div style={{ marginLeft: 200, padding: '24px', maxWidth: 900 }}>
        {/* Header + Save */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-base font-semibold" style={{ color: '#f0f6fc' }}>Settings</h1>
            <p className="text-xs mt-0.5" style={{ color: '#6b7280' }}>
              Changes are auto-saved to browser storage
              {savedFlash && <span style={{ color: '#3ecf8e' }}> ✓ saved</span>}
            </p>
          </div>
          <button onClick={handleSave}
            className="px-4 py-2 rounded-lg text-sm font-semibold hover:opacity-90 transition-opacity"
            style={{ background: savedFlash ? '#22863a' : '#3ecf8e', color: '#0f1117' }}>
            {savedFlash ? '✓ Saved' : 'Save Now'}
          </button>
        </div>

        <div className="grid gap-4 mb-4" style={{ gridTemplateColumns: cfg.s3_bucket ? '1fr 1fr' : '1fr' }}>
          {/* Production DB */}
          <Card title="Production Database" icon={<DbIcon />}>
            <Field label="Host / RDS Endpoint" value={cfg.host} onChange={set('host')} placeholder="mydb.cluster.us-east-1.rds.amazonaws.com" />
            <div className="grid gap-3 mb-3" style={{ gridTemplateColumns: '110px 1fr 120px' }}>
              <InlineField label="Port" value={cfg.port} onChange={set('port')} placeholder="5432" />
              <InlineField label="Database Name" value={cfg.database} onChange={set('database')} placeholder="mydb" />
              <InlineField label="Schema" value={cfg.schema} onChange={set('schema')} placeholder="public" />
            </div>
            <div className="grid gap-3 mb-4" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <Field label="Username" value={cfg.username} onChange={set('username')} placeholder="flyway" />
              <Field label="Password" value={cfg.password} onChange={set('password')} type="password" placeholder="••••••••" />
            </div>
            <Btn onClick={testDb} disabled={testing.db || !cfg.host}>
              {testing.db ? 'Testing…' : 'Test Connection'}
            </Btn>
            <TestResult result={dbResult} />
          </Card>

          {/* S3 (shown when configured) */}
          {cfg.s3_bucket && (
            <Card title="S3 Configuration" icon={
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <ellipse cx="12" cy="5" rx="9" ry="3" />
                <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
              </svg>
            }>
              <div className="mb-3 px-3 py-2 rounded-lg text-xs" style={{ background: '#0d1117', border: '1px solid #21262d', color: '#6b7280' }}>
                Credentials come from IAM role attached to ECS task.
              </div>
              <Field label="S3 Bucket" value={cfg.s3_bucket} onChange={set('s3_bucket')} placeholder="my-flyway-bucket" />
              <div className="grid gap-3" style={{ gridTemplateColumns: '1fr 140px' }}>
                <Field label="Key Prefix" value={cfg.s3_prefix} onChange={set('s3_prefix')} placeholder="flyway/" />
                <Field label="Region" value={cfg.s3_region} onChange={set('s3_region')} placeholder="ap-northeast-1" />
              </div>
            </Card>
          )}
        </div>

        {/* S3 setup (when not yet configured) */}
        {!cfg.s3_bucket && (
          <div className="mb-4 rounded-xl p-4" style={{ background: '#161b22', border: '1px solid #21262d' }}>
            <p className="text-xs mb-2" style={{ color: '#6b7280' }}>
              Optional: set an S3 bucket to sync migration files to/from S3
            </p>
            <div style={{ maxWidth: 360 }}>
              <InlineField label="S3 Bucket" value={cfg.s3_bucket} onChange={set('s3_bucket')} placeholder="my-flyway-bucket (leave empty to skip S3)" />
            </div>
          </div>
        )}

        {/* Staging DB */}
        <Card title="Test / Staging DB" accent="#f5a623" icon={
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f5a623" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="16,18 22,12 16,6" /><polyline points="8,6 2,12 8,18" />
          </svg>
        }>
          <div className="grid gap-4" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div>
              <div className="grid gap-3 mb-3" style={{ gridTemplateColumns: '1fr 100px' }}>
                <Field label="Host / Endpoint" value={cfg.staging_host} onChange={set('staging_host')} placeholder="staging-db.rds.amazonaws.com" />
                <Field label="Port" value={cfg.staging_port} onChange={set('staging_port')} placeholder={cfg.port || '5432'} />
              </div>
              <Field label="Database Name" value={cfg.staging_db_name} onChange={set('staging_db_name')} placeholder={cfg.database || 'mydb_staging'} />
            </div>
            <div>
              <div className="grid gap-3 mb-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <Field label="Username" value={cfg.staging_username} onChange={set('staging_username')} placeholder={cfg.username || 'flyway'} />
                <Field label="Password" value={cfg.staging_password} onChange={set('staging_password')} type="password" placeholder="••••••••" />
              </div>
              <Field label="Schema" value={cfg.staging_schema} onChange={set('staging_schema')} placeholder={cfg.schema || 'public'} />
            </div>
          </div>
          <Btn onClick={testStg} disabled={testing.stg || !cfg.staging_host} style={{ color: '#f5a623', borderColor: '#f5a623' }}>
            {testing.stg ? 'Testing…' : 'Test Staging Connection'}
          </Btn>
          <TestResult result={stgResult} />
        </Card>
      </div>
    </div>
  )
}
