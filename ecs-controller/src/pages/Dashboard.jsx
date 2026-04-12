import { useState, useEffect, useRef } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import {
  getConfig, listFiles, deleteFile, deleteFiles, uploadFiles,
  startMigration, startStaging, pollStatus, getHistory,
  listS3Files, uploadToS3, downloadFromS3,
  devClear, devSeed, devUpdate, devQuery,
} from '../api.js'
import { STORAGE_KEY, DEFAULT_CONFIG } from './Settings.jsx'

function readLocalConfig() {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') } }
  catch { return { ...DEFAULT_CONFIG } }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
function fmtSize(b) { return b < 1024 ? `${b}B` : `${(b / 1024).toFixed(1)}KB` }
function parseFilename(name) {
  const m = name.match(/^V([\d]+(?:[._]\d+)*)__(.+)\.sql$/i)
  if (!m) return null
  const ver = m[1].replace(/_/g, '.')
  return { version: `V${ver}`, raw_version: ver, description: m[2].replace(/_/g, ' ') }
}

// ── Sub-components ────────────────────────────────────────────────────────────
function Card({ children, style, className }) {
  return (
    <div className={`rounded-xl ${className || ''}`} style={{ background: '#161b22', border: '1px solid #21262d', ...style }}>
      {children}
    </div>
  )
}
function CardHd({ children }) {
  return <div className="flex items-center gap-2 px-4 py-3" style={{ borderBottom: '1px solid #21262d' }}>{children}</div>
}
function CardBody({ children, style }) {
  return <div className="p-4" style={style}>{children}</div>
}
function Num({ n }) {
  return <span className="font-mono text-xs" style={{ color: '#4b5563' }}>{String(n).padStart(2, '0')}</span>
}
function SectionLabel({ children }) {
  return <div className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: '#6b7280' }}>{children}</div>
}
function Badge({ status }) {
  const colors = { SUCCESS: '#3ecf8e', FAILED: '#f66070', RUNNING: '#f5a623', SKIPPED: '#6b7280' }
  return (
    <span className="text-xs font-mono px-2 py-0.5 rounded-full" style={{ color: colors[status] || '#6b7280', background: `${colors[status] || '#6b7280'}18`, border: `1px solid ${colors[status] || '#6b7280'}40` }}>
      {status}
    </span>
  )
}
function Btn({ children, onClick, disabled, className, style, size = 'md' }) {
  const pad = size === 'sm' ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm'
  return (
    <button onClick={onClick} disabled={disabled}
      className={`rounded-lg font-medium transition-opacity hover:opacity-80 disabled:opacity-40 flex items-center gap-1.5 ${pad} ${className || ''}`}
      style={{ border: '1px solid #30363d', color: '#d1d5db', background: 'transparent', ...style }}>
      {children}
    </button>
  )
}

// Sidebar navigation
function Sidebar({ config, onStop }) {
  const navigate = useNavigate()
  return (
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
        <div className="text-xs mb-1 px-2" style={{ color: '#4b5563' }}>Navigation</div>
        <Link to="/dashboard" className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm mb-0.5" style={{ color: '#3ecf8e', background: 'rgba(62,207,142,0.08)' }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></svg>
          Dashboard
        </Link>
        <Link to="/settings" className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm mb-0.5" style={{ color: '#6b7280' }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19.07 4.93l-1.41 1.41M4.93 4.93l1.41 1.41M19.07 19.07l-1.41-1.41M4.93 19.07l1.41-1.41M12 2v2M12 20v2M2 12h2M20 12h2" /></svg>
          Settings
        </Link>
      </div>

      <div className="px-3 py-3" style={{ borderTop: '1px solid #21262d' }}>
        <div className="text-xs mb-2 px-2" style={{ color: '#4b5563' }}>
          {config?.host ? `${config.host}:${config.port}` : 'DB not configured'}
        </div>
        <div className="flex items-center gap-1.5 px-2 mb-3">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: '#3ecf8e' }} />
          <span className="text-xs font-mono" style={{ color: '#3ecf8e' }}>RUNNING</span>
        </div>
        <button onClick={onStop} className="w-full text-xs py-1.5 rounded-lg" style={{ border: '1px solid #f66070', color: '#f66070', background: 'transparent' }}>
          Stop App
        </button>
      </div>
    </div>
  )
}

// Upload Card
function UploadCard({ config, onFilesChanged }) {
  const [staged, setStaged] = useState([])
  const [uploading, setUploading] = useState(false)
  const [uploadMsg, setUploadMsg] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [s3Open, setS3Open] = useState(false)
  const [s3Files, setS3Files] = useState([])
  const [s3Selected, setS3Selected] = useState(new Set())
  const [s3Msg, setS3Msg] = useState(null)
  const inputRef = useRef()

  function addFiles(rawFiles) {
    const existing = new Set(staged.map(f => f.file.name))
    const newFiles = rawFiles.filter(f => f.name.endsWith('.sql') && !existing.has(f.name))
      .map(f => ({ file: f, parsed: parseFilename(f.name) }))
    setStaged(prev => [...prev, ...newFiles])
  }

  async function doUpload() {
    setUploading(true); setUploadMsg(null)
    const fd = new FormData()
    staged.forEach(f => fd.append('files', f.file))
    try {
      const data = await uploadFiles(fd)
      const ok = data.uploaded?.length > 0
      setUploadMsg({ ok, text: ok ? `✓ ${data.uploaded.length} file(s) uploaded` : data.errors?.[0] || 'Upload failed' })
      if (ok) { setStaged([]); onFilesChanged() }
    } catch (e) { setUploadMsg({ ok: false, text: e.message }) }
    finally { setUploading(false) }
  }

  async function toggleS3() {
    setS3Open(v => !v)
    if (!s3Open) {
      try { const d = await listS3Files(); setS3Files(d.files || []) } catch { setS3Files([]) }
    }
  }

  async function doS3Download(mode) {
    setS3Msg({ ok: null, text: 'Downloading…' })
    const files = mode === 'selected' ? [...s3Selected] : null
    try {
      const d = await downloadFromS3(files)
      setS3Msg({ ok: d.success, text: d.success ? `✓ Downloaded ${d.downloaded.length} file(s)` : d.message || 'Failed' })
      if (d.success) onFilesChanged()
    } catch (e) { setS3Msg({ ok: false, text: e.message }) }
  }

  return (
    <Card>
      <CardHd>
        <Num n={1} />
        <span className="text-sm font-medium" style={{ color: '#f0f6fc' }}>Upload SQL Files</span>
      </CardHd>
      <CardBody>
        {/* Dropzone */}
        <div
          onClick={() => inputRef.current.click()}
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => { e.preventDefault(); setDragging(false); addFiles(Array.from(e.dataTransfer.files)) }}
          className="rounded-lg flex flex-col items-center justify-center gap-2 cursor-pointer transition-colors"
          style={{ border: `1.5px dashed ${dragging ? '#3ecf8e' : '#30363d'}`, padding: '24px 16px', background: dragging ? 'rgba(62,207,142,0.04)' : '#0d1117' }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4b5563" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="16,16 12,12 8,16" /><line x1="12" y1="12" x2="12" y2="21" />
            <path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3" />
          </svg>
          <span className="text-xs" style={{ color: '#6b7280' }}>Drop <code style={{ color: '#3ecf8e' }}>.sql</code> files or click to browse</span>
          <span className="text-xs" style={{ color: '#4b5563' }}>Flyway format: V2__add_users.sql</span>
        </div>
        <input ref={inputRef} type="file" multiple accept=".sql" className="hidden" onChange={e => addFiles(Array.from(e.target.files))} />

        {/* Staged files */}
        {staged.length > 0 && (
          <div className="mt-3 flex flex-col gap-1">
            {staged.map((f, i) => (
              <div key={i} className="flex items-center gap-2 text-xs px-2 py-1.5 rounded-lg" style={{ background: '#0d1117' }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" /><polyline points="14,2 14,8 20,8" /></svg>
                <span className="flex-1 truncate font-mono" style={{ color: '#d1d5db' }}>{f.file.name}</span>
                {f.parsed && <span style={{ color: '#3ecf8e' }}>{f.parsed.version}</span>}
                <span style={{ color: '#4b5563' }}>{fmtSize(f.file.size)}</span>
                <button onClick={() => setStaged(s => s.filter((_, j) => j !== i))} style={{ color: '#6b7280' }}>✕</button>
              </div>
            ))}
            <div className="flex items-center gap-3 mt-2">
              <Btn onClick={doUpload} disabled={uploading} size="sm" style={{ color: '#3ecf8e', borderColor: '#3ecf8e' }}>
                {uploading ? 'Uploading…' : 'Upload to Container'}
              </Btn>
              {uploadMsg && <span className="text-xs font-mono" style={{ color: uploadMsg.ok ? '#3ecf8e' : '#f66070' }}>{uploadMsg.text}</span>}
            </div>
          </div>
        )}

        {/* S3 section (prod only) */}
        {config?.release && config?.s3_bucket && (
          <div className="mt-3 pt-3" style={{ borderTop: '1px solid #21262d' }}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-mono" style={{ color: '#4b5563' }}>s3://{config.s3_bucket}/{config.s3_prefix}</span>
              <Btn size="sm" onClick={toggleS3}>Save to S3</Btn>
            </div>
            {s3Open && (
              <div>
                <div className="rounded-lg p-2 mb-2 flex flex-col gap-1 max-h-36 overflow-auto" style={{ background: '#0d1117', border: '1px solid #21262d' }}>
                  {s3Files.length === 0
                    ? <span className="text-xs" style={{ color: '#6b7280' }}>No files in container.</span>
                    : s3Files.map(f => (
                      <label key={f.filename} className="flex items-center gap-2 text-xs cursor-pointer">
                        <input type="checkbox" checked={s3Selected.has(f.filename)} onChange={e => {
                          setS3Selected(s => { const n = new Set(s); e.target.checked ? n.add(f.filename) : n.delete(f.filename); return n })
                        }} />
                        <span className="font-mono" style={{ color: '#d1d5db' }}>{f.filename}</span>
                      </label>
                    ))
                  }
                </div>
                <div className="flex gap-2">
                  <Btn size="sm" onClick={() => doS3Download('all')}>Download All</Btn>
                  <Btn size="sm" onClick={() => doS3Download('selected')}>Download Selected</Btn>
                  {s3Msg && <span className="text-xs font-mono" style={{ color: s3Msg.ok ? '#3ecf8e' : '#f66070' }}>{s3Msg.text}</span>}
                </div>
              </div>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  )
}

// Version Card
function VersionCard({ files, selectedVersion, onSelect, onRefresh }) {
  const [deleteStatus, setDeleteStatus] = useState(null)
  const [selected, setSelected] = useState(new Set())

  const versions = (() => {
    const seen = new Map()
    files.filter(f => f.parsed).forEach(f => {
      if (!seen.has(f.parsed.version)) seen.set(f.parsed.version, { ...f.parsed, size: f.size })
    })
    return [...seen.values()].sort((a, b) => a.raw_version.localeCompare(b.raw_version, undefined, { numeric: true }))
  })()

  async function doDelete(filenames) {
    setDeleteStatus('Deleting…')
    try {
      const d = await deleteFiles(filenames)
      setDeleteStatus(d.success ? `✓ Deleted ${d.deleted.length} file(s)` : '❌ Delete failed')
      onRefresh()
      setSelected(new Set())
    } catch (e) { setDeleteStatus('❌ ' + e.message) }
  }

  async function deleteSelectedFiles() {
    if (!selected.size) return
    if (!confirm(`Delete ${selected.size} version(s)?`)) return
    const filenames = files.filter(f => f.parsed && selected.has(f.parsed.version)).map(f => f.filename)
    doDelete(filenames)
  }

  async function deleteAll() {
    if (!confirm('Delete ALL migration files?')) return
    doDelete(null)
  }

  return (
    <Card>
      <CardHd>
        <Num n={2} />
        <span className="text-sm font-medium flex-1" style={{ color: '#f0f6fc' }}>Select Target Version</span>
        <button onClick={onRefresh} style={{ color: '#6b7280' }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23,4 23,10 17,10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" /></svg>
        </button>
      </CardHd>
      <CardBody>
        {versions.length > 0 && (
          <div className="flex items-center gap-2 mb-3 p-2 rounded-lg" style={{ background: '#0d1117', border: '1px solid #21262d' }}>
            <span className="text-xs" style={{ color: '#6b7280' }}>Actions:</span>
            <Btn size="sm" onClick={deleteSelectedFiles} style={{ color: '#f66070', borderColor: '#f66070' }}>Delete Selected</Btn>
            <Btn size="sm" onClick={deleteAll} style={{ color: '#f66070', borderColor: '#f66070' }}>Delete All</Btn>
            {deleteStatus && <span className="text-xs font-mono ml-auto" style={{ color: deleteStatus.startsWith('✓') ? '#3ecf8e' : '#f66070' }}>{deleteStatus}</span>}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          {versions.length === 0 && (
            <div className="text-xs text-center py-8" style={{ color: '#6b7280' }}>No SQL files in container volume</div>
          )}
          {versions.map(v => (
            <div key={v.version}
              onClick={() => onSelect(selectedVersion === v.version ? null : v.version)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors"
              style={{ background: selectedVersion === v.version ? 'rgba(62,207,142,0.08)' : '#0d1117', border: `1px solid ${selectedVersion === v.version ? 'rgba(62,207,142,0.3)' : '#21262d'}` }}
            >
              <input type="checkbox" checked={selected.has(v.version)} onClick={e => e.stopPropagation()}
                onChange={e => setSelected(s => { const n = new Set(s); e.target.checked ? n.add(v.version) : n.delete(v.version); return n })}
                style={{ accentColor: '#f66070' }} />
              <span className="font-mono text-xs font-semibold" style={{ color: '#3ecf8e', minWidth: 40 }}>{v.version}</span>
              <span className="text-xs flex-1" style={{ color: '#9ca3af' }}>{v.description}</span>
              {v.size && <span className="text-xs font-mono" style={{ color: '#4b5563' }}>{fmtSize(v.size)}</span>}
            </div>
          ))}
          {versions.length > 0 && (
            <div onClick={() => onSelect('latest')}
              className="flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors"
              style={{ background: selectedVersion === 'latest' ? 'rgba(96,165,250,0.08)' : '#0d1117', border: `1px solid ${selectedVersion === 'latest' ? 'rgba(96,165,250,0.3)' : '#21262d'}` }}
            >
              <span className="font-mono text-xs font-semibold" style={{ color: '#60a5fa', minWidth: 40 }}>latest</span>
              <span className="text-xs" style={{ color: '#9ca3af' }}>migrate all pending</span>
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  )
}

// Log Panel
function LogPanel({ logs }) {
  const ref = useRef()
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight }, [logs])
  const levelColor = { INFO: '#9ca3af', WARN: '#f5a623', ERROR: '#f66070', SUCCESS: '#3ecf8e' }
  return (
    <div ref={ref} className="rounded-lg overflow-auto font-mono text-xs" style={{ background: '#0d1117', border: '1px solid #21262d', height: 200, padding: '8px 12px' }}>
      {!logs.length
        ? <span style={{ color: '#4b5563' }}>Waiting for logs…</span>
        : logs.map((l, i) => (
          <div key={i} className="flex gap-2 py-0.5">
            <span style={{ color: '#4b5563', flexShrink: 0 }}>{l.timestamp?.slice(11, 19)}</span>
            <span style={{ color: levelColor[l.level] || '#9ca3af' }}>{l.message}</span>
          </div>
        ))
      }
    </div>
  )
}

// Verification Panel
function VerifyPanel({ v }) {
  if (!v) return null
  const health = v.health || {}
  const diff = v.schema_diff || {}
  const hist = v.recent_history || []
  const added = diff.added_tables || [], removed = diff.removed_tables || [], modified = diff.modified_tables || {}
  return (
    <div className="rounded-lg overflow-hidden" style={{ border: '1px solid #21262d' }}>
      <div className="flex items-center gap-2 px-4 py-2.5" style={{ borderBottom: '1px solid #21262d' }}>
        <span style={{ color: health.ok !== false ? '#3ecf8e' : '#f66070' }}>{health.ok !== false ? '✓' : '✗'}</span>
        <span className="text-xs font-semibold" style={{ color: '#d1d5db' }}>DB Health</span>
        <span className="text-xs font-mono" style={{ color: '#6b7280' }}>{health.message}</span>
      </div>
      <div className="px-4 py-2.5" style={{ borderBottom: '1px solid #21262d' }}>
        <SectionLabel>Schema Changes</SectionLabel>
        {!added.length && !removed.length && !Object.keys(modified).length
          ? <span className="text-xs font-mono" style={{ color: '#6b7280' }}>No schema changes detected</span>
          : <>
            {added.map(t => <div key={t} className="text-xs font-mono py-0.5" style={{ color: '#3ecf8e' }}>+ {t} <span style={{ color: '#4b5563' }}>new table</span></div>)}
            {removed.map(t => <div key={t} className="text-xs font-mono py-0.5" style={{ color: '#f66070' }}>− {t} <span style={{ color: '#4b5563' }}>dropped</span></div>)}
            {Object.entries(modified).map(([tbl, ch]) => (
              <div key={tbl} className="text-xs font-mono py-0.5" style={{ color: '#f5a623' }}>~ {tbl} <span style={{ color: '#4b5563' }}>{[...ch.added, ...ch.removed].join(', ')}</span></div>
            ))}
          </>
        }
      </div>
      {hist.length > 0 && (
        <div className="px-4 py-2.5">
          <SectionLabel>Recent Migrations</SectionLabel>
          {hist.map((h, i) => (
            <div key={i} className="flex items-center gap-2 py-0.5 text-xs">
              <span style={{ color: h.success !== false ? '#3ecf8e' : '#f66070' }}>{h.success !== false ? '✓' : '✗'}</span>
              <span className="font-mono" style={{ color: '#60a5fa', minWidth: 36 }}>V{h.version}</span>
              <span className="flex-1" style={{ color: '#d1d5db' }}>{h.description}</span>
              <span className="font-mono" style={{ color: '#4b5563' }}>{h.execution_time}ms</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Migration Card
function MigrationCard({ config, selectedVersion }) {
  const [logs, setLogs] = useState([])
  const [showLog, setShowLog] = useState(false)
  const [verify, setVerify] = useState(null)
  const [showVerify, setShowVerify] = useState(false)
  // Production state
  const [prodState, setProdState] = useState({ running: false, status: 'idle' }) // idle|running|success|failed
  // Staging state
  const [stgState, setStgState] = useState({ running: false, result: null }) // null|success|failed

  const prodPollRef = useRef(); const stgPollRef = useRef()
  const prodExecRef = useRef(); const stgExecRef = useRef()

  function appendLog(level, msg) {
    setLogs(l => [...l, { level, timestamp: new Date().toISOString(), message: msg }])
  }

  async function runProduction() {
    if (prodState.running || !selectedVersion) return
    setProdState({ running: true, status: 'running' })
    setShowLog(true); setLogs([]); setShowVerify(false); setVerify(null)
    const db = {
      host: config?.host, port: config?.port, database: config?.database,
      username: config?.username, password: config?.password, schema: config?.schema,
    }
    try {
      const d = await startMigration(selectedVersion, db)
      if (!d.executionId) { setProdState({ running: false, status: 'failed' }); appendLog('ERROR', d.message || 'Failed to start'); return }
      prodExecRef.current = d.executionId
      prodPollRef.current = setInterval(pollProd, 3000); pollProd()
    } catch (e) { setProdState({ running: false, status: 'failed' }); appendLog('ERROR', e.message) }
  }

  async function pollProd() {
    try {
      const d = await pollStatus(prodExecRef.current)
      if (d.logs) setLogs(d.logs)
      if (d.status === 'SUCCESS') { clearInterval(prodPollRef.current); setProdState({ running: false, status: 'success' }); setVerify(d.verification); setShowVerify(true) }
      if (d.status === 'FAILED') { clearInterval(prodPollRef.current); setProdState({ running: false, status: 'failed' }); appendLog('ERROR', d.errorMessage || 'Migration failed') }
    } catch { }
  }

  async function runStaging() {
    const stagingConfigured = !!config?.staging_host
    if (stgState.running || !selectedVersion || !stagingConfigured) return
    setStgState({ running: true, result: null })
    setShowLog(true); setLogs([]); setShowVerify(false); setVerify(null)
    const stagingDb = {
      host: config.staging_host,
      port: config.staging_port || config.port,
      database: config.staging_db_name || config.database,
      username: config.staging_username || config.username,
      password: config.staging_password || config.password,
      schema: config.staging_schema || config.schema,
    }
    try {
      const d = await startStaging(selectedVersion, stagingDb)
      if (!d.executionId) { setStgState({ running: false, result: 'failed' }); appendLog('ERROR', d.message || 'Failed to start staging'); return }
      stgExecRef.current = d.executionId
      stgPollRef.current = setInterval(pollStg, 3000); pollStg()
    } catch (e) { setStgState({ running: false, result: 'failed' }); appendLog('ERROR', e.message) }
  }

  async function pollStg() {
    try {
      const d = await pollStatus(stgExecRef.current)
      if (d.logs) setLogs(d.logs)
      if (d.status === 'SUCCESS') { clearInterval(stgPollRef.current); setStgState({ running: false, result: 'success' }); setVerify(d.verification); setShowVerify(true) }
      if (d.status === 'FAILED') { clearInterval(stgPollRef.current); setStgState({ running: false, result: 'failed' }); appendLog('ERROR', d.errorMessage || 'Staging failed') }
    } catch { }
  }

  const prodBtnStyle = prodState.status === 'failed'
    ? { border: '1px solid #f66070', color: '#f66070' }
    : { background: '#3ecf8e', color: '#0f1117', border: 'none' }
  const prodBtnText = prodState.running ? 'Running…' : prodState.status === 'success' ? 'Run on Production' : prodState.status === 'failed' ? '↺ Retry Migration' : 'Run on Production'

  return (
    <Card>
      <CardHd>
        <Num n={3} />
        <span className="text-sm font-medium" style={{ color: '#f0f6fc' }}>Execute Migration</span>
      </CardHd>
      <CardBody>
        <div className="flex gap-8 flex-wrap">
          {/* Left: steps */}
          <div className="flex flex-col gap-4" style={{ minWidth: 220 }}>
            {/* Step 1: Staging */}
            <div className="pb-4" style={{ borderBottom: '1px solid #21262d' }}>
              <span className="text-xs font-bold tracking-wider px-2 py-0.5 rounded-full" style={{ color: '#f5a623', background: 'rgba(245,166,35,0.1)', border: '1px solid rgba(245,166,35,0.25)' }}>
                STEP 1 · OPTIONAL
              </span>
              <div className="text-xs font-semibold mt-2 mb-1" style={{ color: '#d1d5db' }}>Test on Staging</div>
              {config?.staging_host
                ? <div className="text-xs font-mono mb-2" style={{ color: '#6b7280' }}>{config.staging_host}{config.staging_db_name ? ' / ' + config.staging_db_name : ''}</div>
                : <Link to="/settings" className="text-xs mb-2 block" style={{ color: '#6b7280' }}>Not configured — go to Settings →</Link>
              }
              <Btn onClick={runStaging} disabled={stgState.running || !selectedVersion || !config?.staging_host} size="sm" style={{ color: '#f5a623', borderColor: '#f5a623' }}>
                {stgState.running ? 'Running…' : 'Run on Staging'}
              </Btn>
              {stgState.result && (
                <div className="text-xs font-mono mt-2" style={{ color: stgState.result === 'success' ? '#3ecf8e' : '#f66070' }}>
                  {stgState.result === 'success' ? '✓ Staging passed' : '✗ Staging failed'}
                </div>
              )}
            </div>

            {/* Step 2: Production */}
            <div>
              <span className="text-xs font-bold tracking-wider px-2 py-0.5 rounded-full" style={{ color: '#3ecf8e', background: 'rgba(62,207,142,0.1)', border: '1px solid rgba(62,207,142,0.25)' }}>
                STEP 2 · PRODUCTION
              </span>
              <div className="text-xs font-semibold mt-2 mb-1" style={{ color: '#d1d5db' }}>Apply to Production</div>
              {config?.host
                ? <div className="text-xs font-mono mb-3" style={{ color: '#6b7280' }}>{config.host}:{config.port} / {config.database}</div>
                : <div className="text-xs mb-3" style={{ color: '#6b7280' }}>Not configured</div>
              }
              <button onClick={runProduction} disabled={prodState.running || !selectedVersion}
                className="px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-40 hover:opacity-90 transition-opacity"
                style={prodBtnStyle}>
                {prodState.running && <span className="inline-block w-3 h-3 rounded-full border-2 animate-spin mr-2" style={{ borderColor: 'currentColor', borderTopColor: 'transparent' }} />}
                {prodBtnText}
              </button>
            </div>
          </div>

          {/* Right: logs + verify */}
          <div className="flex-1 flex flex-col gap-3" style={{ minWidth: 280 }}>
            {showLog && (
              <>
                <SectionLabel>Execution Log</SectionLabel>
                <LogPanel logs={logs} />
              </>
            )}
            {showVerify && verify && (
              <>
                <SectionLabel>Post-Migration Verification</SectionLabel>
                <VerifyPanel v={verify} />
              </>
            )}
          </div>
        </div>
      </CardBody>
    </Card>
  )
}

// History Card
function HistoryCard({ history, onRefresh }) {
  return (
    <Card>
      <CardHd>
        <span className="text-sm font-medium flex-1" style={{ color: '#f0f6fc' }}>Migration History</span>
        <button onClick={onRefresh} style={{ color: '#6b7280' }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23,4 23,10 17,10" /><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" /></svg>
        </button>
      </CardHd>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr style={{ borderBottom: '1px solid #21262d' }}>
              {['Execution ID', 'Version', 'Status', 'Started', 'Finished', 'Duration'].map(h => (
                <th key={h} className="text-left px-4 py-2.5 font-medium" style={{ color: '#6b7280' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {!history.length && (
              <tr><td colSpan={6} className="text-center py-8 text-xs" style={{ color: '#6b7280' }}>No migrations recorded yet.</td></tr>
            )}
            {history.map(h => {
              const dur = h.finishedAt ? Math.round((new Date(h.finishedAt) - new Date(h.startedAt)) / 1000) + 's' : '—'
              return (
                <tr key={h.executionId} style={{ borderBottom: '1px solid #21262d' }}>
                  <td className="px-4 py-2.5 font-mono" style={{ color: '#4b5563' }}>{h.executionId.slice(0, 8)}…</td>
                  <td className="px-4 py-2.5 font-mono" style={{ color: '#d1d5db' }}>{h.version}</td>
                  <td className="px-4 py-2.5"><Badge status={h.status} /></td>
                  <td className="px-4 py-2.5 font-mono" style={{ color: '#9ca3af' }}>{h.startedAt?.slice(0, 19).replace('T', ' ')}</td>
                  <td className="px-4 py-2.5 font-mono" style={{ color: '#9ca3af' }}>{h.finishedAt ? h.finishedAt.slice(0, 19).replace('T', ' ') : '—'}</td>
                  <td className="px-4 py-2.5 font-mono" style={{ color: '#9ca3af' }}>{dur}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

// Dev Tools Card
function DevToolsCard({ config, onClear }) {
  const [result, setResult] = useState(null)
  const db = { host: config?.host, port: config?.port, database: config?.database, username: config?.username, password: config?.password, schema: config?.schema }
  async function run(fn) { try { setResult(await fn(db)) } catch (e) { setResult({ success: false, message: e.message }) } }
  async function doClear() {
    if (!confirm('Drop all tables + clear files + reset history?')) return
    const d = await devClear(db); setResult(d); if (d.success) onClear()
  }
  return (
    <Card style={{ border: '1px solid rgba(245,166,35,0.4)' }}>
      <CardHd>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#f5a623" strokeWidth="2"><polyline points="16,18 22,12 16,6" /><polyline points="8,6 2,12 8,18" /></svg>
        <span className="text-sm font-medium flex-1" style={{ color: '#f5a623' }}>Dev Tools</span>
        <span className="text-xs" style={{ color: '#6b7280' }}>local only</span>
        <Btn size="sm" onClick={doClear} style={{ color: '#f66070', borderColor: '#f66070' }}>Clear DB & Files</Btn>
      </CardHd>
      <CardBody>
        <div className="flex gap-2 flex-wrap">
          <Btn size="sm" onClick={() => run(devSeed)}>+ Insert User</Btn>
          <Btn size="sm" onClick={() => run(devUpdate)}>~ Update User</Btn>
          <Btn size="sm" onClick={() => run(devQuery)}>? Query Users</Btn>
        </div>
        {result && (
          <pre className="mt-3 p-3 rounded-lg text-xs font-mono overflow-auto max-h-36" style={{ background: '#0d1117', border: '1px solid #21262d', color: result.success === false ? '#f66070' : '#3ecf8e' }}>
            {JSON.stringify(result, null, 2)}
          </pre>
        )}
      </CardBody>
    </Card>
  )
}

// ── Dashboard Page ────────────────────────────────────────────────────────────
export default function Dashboard() {
  const navigate = useNavigate()
  const [config, setConfig] = useState(null)
  const [files, setFiles] = useState([])
  const [selectedVersion, setVersion] = useState(null)
  const [history, setHistory] = useState([])

  useEffect(() => {
    loadConfig(); loadFiles(); loadHistory()
  }, [])

  async function loadConfig() {
    const local = readLocalConfig()
    try {
      const meta = await getConfig() // { env_mode, release }
      setConfig({ ...local, env_mode: meta.env_mode, release: meta.release })
    } catch {
      setConfig(local)
    }
  }
  async function loadFiles() { try { const d = await listFiles(); setFiles(d.files || []) } catch { } }
  async function loadHistory() { try { const d = await getHistory(); setHistory(d.migrations || []) } catch { } }

  async function handleStop() {
    const { taskStop } = await import('../api.js')
    await taskStop()
    navigate('/')
  }

  return (
    <div style={{ background: '#0f1117', minHeight: '100vh' }}>
      <Sidebar config={config} onStop={handleStop} />
      <div style={{ marginLeft: 200, padding: '24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <div>
            <h1 className="text-base font-semibold" style={{ color: '#f0f6fc' }}>Run Migration</h1>
            <p className="text-xs mt-0.5" style={{ color: '#6b7280' }}>{config?.database || 'DB not configured'}</p>
          </div>
          <span className="text-xs px-2 py-0.5 rounded font-mono" style={{ background: 'rgba(62,207,142,0.1)', color: '#3ecf8e', border: '1px solid rgba(62,207,142,0.2)' }}>
            {config?.env_mode || 'local'}
          </span>
        </div>

        {/* Row 1: Upload + Version */}
        <div className="grid gap-4" style={{ gridTemplateColumns: '0.75fr 1.6fr' }}>
          <UploadCard config={config} onFilesChanged={loadFiles} />
          <VersionCard files={files} selectedVersion={selectedVersion} onSelect={setVersion} onRefresh={loadFiles} />
        </div>

        {/* Row 2: Migration */}
        <MigrationCard config={config} selectedVersion={selectedVersion} />

        {/* Dev Tools (local only) */}
        {config?.env_mode === 'local' && (
          <DevToolsCard config={config} onClear={() => { loadFiles(); loadHistory() }} />
        )}

        {/* History */}
        <HistoryCard history={history} onRefresh={loadHistory} />
      </div>
    </div>
  )
}
