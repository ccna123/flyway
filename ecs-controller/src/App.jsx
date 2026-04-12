import { useState, useEffect, useRef } from 'react'

const API_BASE = import.meta.env.VITE_API_BASE || ''
const MOCK = import.meta.env.VITE_MOCK === 'true'

// Mock API for local dev — simulates STOPPED → STARTING → RUNNING flow
let _mockStatus = 'STOPPED'
async function mockFetch(path) {
  await new Promise(r => setTimeout(r, 600))
  if (path === '/status') return { status: _mockStatus, url: _mockStatus === 'RUNNING' ? 'http://localhost:5000' : null }
  if (path === '/start') { _mockStatus = 'STARTING'; setTimeout(() => { _mockStatus = 'RUNNING' }, 8000); return {} }
  if (path === '/stop') { _mockStatus = 'STOPPING'; setTimeout(() => { _mockStatus = 'STOPPED' }, 5000); return {} }
}

async function apiFetch(path, { method = 'GET', apiKey } = {}) {
  if (MOCK) return mockFetch(path)
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'x-api-key': apiKey },
  })
  if (res.status === 403) throw new Error('FORBIDDEN')
  return res.json()
}

const STATUS = {
  STOPPED: { color: '#f66070', label: 'STOPPED', pulse: false },
  STARTING: { color: '#f5a623', label: 'STARTING', pulse: true },
  RUNNING: { color: '#3ecf8e', label: 'RUNNING', pulse: false },
  STOPPING: { color: '#f5a623', label: 'STOPPING', pulse: true },
  UNKNOWN: { color: '#6b7280', label: 'UNKNOWN', pulse: false },
}

export default function App() {
  const [status, setStatus] = useState('UNKNOWN')
  const [appUrl, setAppUrl] = useState(null)
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('ecs_api_key') || '')
  const [showModal, setShowModal] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)
  const pollRef = useRef(null)

  useEffect(() => {
    if (!apiKey) { setShowModal(true); return }
    fetchStatus()
  }, [apiKey])

  useEffect(() => {
    clearInterval(pollRef.current)
    if (status === 'STARTING' || status === 'STOPPING') {
      pollRef.current = setInterval(fetchStatus, 5000)
    }
    return () => clearInterval(pollRef.current)
  }, [status, apiKey])

  async function fetchStatus() {
    if (!apiKey && !MOCK) return
    try {
      const data = await apiFetch('/status', { apiKey })
      setStatus(data.status || 'UNKNOWN')
      setAppUrl(data.url || null)
      setLastUpdated(new Date())
      setError(null)
    } catch (e) {
      setError(e.message === 'FORBIDDEN' ? 'Invalid API key' : 'Cannot reach API')
    }
  }

  async function handleStart() {
    setLoading(true); setError(null)
    try {
      await apiFetch('/start', { method: 'POST', apiKey })
      setStatus('STARTING'); setAppUrl(null)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  async function handleStop() {
    setLoading(true); setError(null)
    try {
      await apiFetch('/stop', { method: 'POST', apiKey })
      setStatus('STOPPING'); setAppUrl(null)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  function saveApiKey() {
    const key = keyInput.trim()
    if (!key) return
    localStorage.setItem('ecs_api_key', key)
    setApiKey(key)
    setShowModal(false)
    setKeyInput('')
  }

  const sc = STATUS[status] || STATUS.UNKNOWN
  const isStopped = status === 'STOPPED'
  const isRunning = status === 'RUNNING'
  const isBusy = status === 'STARTING' || status === 'STOPPING'

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6" style={{ background: '#0f1117' }}>

      {/* Header */}
      <div className="mb-8 text-center">
        <div className="flex items-center gap-2 justify-center mb-1">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3ecf8e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <ellipse cx="12" cy="5" rx="9" ry="3" />
            <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
          </svg>
          <span className="text-white font-semibold text-base tracking-tight">Migration Controller</span>
        </div>
        <p className="text-xs" style={{ color: '#6b7280' }}>Manage FlywayOps ECS task</p>
      </div>

      {/* Main card */}
      <div className="rounded-xl p-8 w-full max-w-xs" style={{ background: '#161b22', border: '1px solid #21262d' }}>

        {/* Status badge */}
        <div className="flex items-center justify-center gap-2 mb-6">
          <span
            className="w-2 h-2 rounded-full"
            style={{
              background: sc.color,
              boxShadow: `0 0 6px ${sc.color}`,
              animation: sc.pulse ? 'pulse 1.5s ease-in-out infinite' : 'none',
            }}
          />
          <span className="text-sm font-mono font-bold tracking-widest" style={{ color: sc.color }}>
            {sc.label}
          </span>
        </div>

        {/* URL when running */}
        {isRunning && appUrl && (
          <div className="rounded-lg p-3 mb-5 text-center" style={{ background: 'rgba(62,207,142,0.08)', border: '1px solid rgba(62,207,142,0.2)' }}>
            <p className="text-xs mb-1" style={{ color: '#6b7280' }}>Application URL</p>
            <a
              href={appUrl} target="_blank" rel="noopener noreferrer"
              className="text-sm font-mono break-all hover:underline"
              style={{ color: '#3ecf8e' }}
            >
              {appUrl}
            </a>
          </div>
        )}

        {/* Busy spinner */}
        {isBusy && (
          <div className="flex items-center justify-center gap-2 mb-5">
            <div className="w-3.5 h-3.5 rounded-full border-2 animate-spin" style={{ borderColor: '#f5a623', borderTopColor: 'transparent' }} />
            <span className="text-xs" style={{ color: '#6b7280' }}>
              {status === 'STARTING' ? 'Waiting for task to be ready…' : 'Stopping task…'}
            </span>
          </div>
        )}

        {/* Action button */}
        {isStopped && (
          <button
            onClick={handleStart} disabled={loading}
            className="w-full py-2.5 rounded-lg font-semibold text-sm transition-opacity hover:opacity-90 disabled:opacity-50"
            style={{ background: '#3ecf8e', color: '#0f1117' }}
          >
            {loading ? 'Starting…' : 'Start App'}
          </button>
        )}

        {isRunning && (
          <button
            onClick={handleStop} disabled={loading}
            className="w-full py-2.5 rounded-lg font-semibold text-sm transition-colors disabled:opacity-50"
            style={{ background: 'transparent', border: '1px solid #f66070', color: '#f66070' }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(246,96,112,0.08)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            {loading ? 'Stopping…' : 'Stop App'}
          </button>
        )}

        {isBusy && (
          <button disabled
            className="w-full py-2.5 rounded-lg font-semibold text-sm"
            style={{ background: 'transparent', border: '1px solid #30363d', color: '#6b7280' }}
          >
            {status === 'STARTING' ? 'Starting…' : 'Stopping…'}
          </button>
        )}

        {/* Error */}
        {error && (
          <p className="text-xs text-center mt-3" style={{ color: '#f66070' }}>{error}</p>
        )}

        {/* Last updated */}
        {lastUpdated && (
          <p className="text-xs text-center mt-4" style={{ color: '#4b5563' }}>
            Updated {lastUpdated.toLocaleTimeString()}
          </p>
        )}
      </div>

      {/* Footer */}
      <div className="mt-4 flex items-center gap-3">
        <button onClick={fetchStatus} className="text-xs transition-colors" style={{ color: '#6b7280' }}
          onMouseEnter={e => e.currentTarget.style.color = '#d1d5db'}
          onMouseLeave={e => e.currentTarget.style.color = '#6b7280'}
        >
          Refresh
        </button>
        <span style={{ color: '#374151' }}>·</span>
        <button
          onClick={() => { setShowModal(true); setKeyInput(apiKey) }}
          className="text-xs transition-colors" style={{ color: '#6b7280' }}
          onMouseEnter={e => e.currentTarget.style.color = '#d1d5db'}
          onMouseLeave={e => e.currentTarget.style.color = '#6b7280'}
        >
          Change API Key
        </button>
      </div>

      {/* API Key Modal */}
      {showModal && (
        <div className="fixed inset-0 flex items-center justify-center p-6 z-50" style={{ background: 'rgba(0,0,0,0.75)' }}>
          <div className="rounded-xl p-6 w-full max-w-xs" style={{ background: '#161b22', border: '1px solid #21262d' }}>
            <h2 className="font-semibold mb-1 text-sm" style={{ color: '#f0f6fc' }}>API Key</h2>
            <p className="text-xs mb-4" style={{ color: '#6b7280' }}>
              Enter the API Gateway key to authenticate requests.
            </p>
            <input
              type="password"
              value={keyInput}
              onChange={e => setKeyInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && saveApiKey()}
              placeholder="••••••••••••••••"
              autoFocus
              className="w-full px-3 py-2 rounded-lg text-sm mb-3 outline-none"
              style={{ background: '#0f1117', border: '1px solid #30363d', color: '#f0f6fc' }}
              onFocus={e => e.currentTarget.style.borderColor = '#3ecf8e'}
              onBlur={e => e.currentTarget.style.borderColor = '#30363d'}
            />
            <button
              onClick={saveApiKey}
              className="w-full py-2 rounded-lg font-semibold text-sm hover:opacity-90 transition-opacity"
              style={{ background: '#3ecf8e', color: '#0f1117' }}
            >
              Save
            </button>
            {apiKey && (
              <button
                onClick={() => setShowModal(false)}
                className="w-full mt-2 py-2 text-sm transition-colors"
                style={{ color: '#6b7280' }}
                onMouseEnter={e => e.currentTarget.style.color = '#d1d5db'}
                onMouseLeave={e => e.currentTarget.style.color = '#6b7280'}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  )
}
