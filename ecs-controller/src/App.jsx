import { useState, useEffect, useRef } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { taskStatus, taskStart, taskStop } from './api.js'
import Dashboard from './pages/Dashboard.jsx'
import Settings from './pages/Settings.jsx'

const MOCK = import.meta.env.VITE_MOCK === 'true'

const TASK_STATUS = {
  STOPPED: { color: '#f66070', pulse: false },
  STARTING: { color: '#f5a623', pulse: true },
  RUNNING: { color: '#3ecf8e', pulse: false },
  STOPPING: { color: '#f5a623', pulse: true },
  UNKNOWN: { color: '#6b7280', pulse: false },
}

// ── API Key Modal ─────────────────────────────────────────────────────────────
function ApiKeyModal({ onSave, canDismiss, onDismiss }) {
  const [key, setKey] = useState('')
  return (
    <div className="fixed inset-0 flex items-center justify-center p-6 z-50" style={{ background: 'rgba(0,0,0,0.75)' }}>
      <div className="rounded-xl p-6 w-full max-w-xs" style={{ background: '#161b22', border: '1px solid #21262d' }}>
        <h2 className="font-semibold mb-1 text-sm" style={{ color: '#f0f6fc' }}>API Key</h2>
        <p className="text-xs mb-4" style={{ color: '#6b7280' }}>Enter the API Gateway key to authenticate requests.</p>
        <input
          type="password" value={key} onChange={e => setKey(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && key.trim() && onSave(key.trim())}
          placeholder="••••••••••••••••" autoFocus
          className="w-full px-3 py-2 rounded-lg text-sm mb-3 outline-none"
          style={{ background: '#0f1117', border: '1px solid #30363d', color: '#f0f6fc' }}
        />
        <button onClick={() => key.trim() && onSave(key.trim())}
          className="w-full py-2 rounded-lg font-semibold text-sm hover:opacity-90"
          style={{ background: '#3ecf8e', color: '#0f1117' }}>
          Save
        </button>
        {canDismiss && (
          <button onClick={onDismiss} className="w-full mt-2 py-2 text-sm" style={{ color: '#6b7280' }}>
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}

// ── Start Screen ──────────────────────────────────────────────────────────────
function StartScreen() {
  const [status, setStatus] = useState('UNKNOWN')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [lastUpd, setLastUpd] = useState(null)
  const [showModal, setShowModal] = useState(false)
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('ecs_api_key') || '')
  const pollRef = useRef(null)
  const navigate = useNavigate()

  useEffect(() => {
    if (!apiKey && !MOCK) { setShowModal(true); return }
    fetchStatus()
  }, [apiKey])

  useEffect(() => {
    clearInterval(pollRef.current)
    if (status === 'STARTING' || status === 'STOPPING') {
      pollRef.current = setInterval(fetchStatus, 5000)
    }
    if (status === 'RUNNING') navigate('/dashboard')
    return () => clearInterval(pollRef.current)
  }, [status])

  async function fetchStatus() {
    try {
      const data = await taskStatus()
      setStatus(data.status || 'UNKNOWN')
      setLastUpd(new Date())
      setError(null)
    } catch (e) {
      setError(e.message === 'FORBIDDEN' ? 'Invalid API key' : 'Cannot reach API')
    }
  }

  async function handleStart() {
    setLoading(true); setError(null)
    try { await taskStart(); setStatus('STARTING') }
    catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  async function handleStop() {
    setLoading(true); setError(null)
    try { await taskStop(); setStatus('STOPPING') }
    catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }

  function saveKey(key) {
    localStorage.setItem('ecs_api_key', key)
    setApiKey(key)
    setShowModal(false)
  }

  const sc = TASK_STATUS[status] || TASK_STATUS.UNKNOWN
  const isStopped = status === 'STOPPED'
  const isRunning = status === 'RUNNING'
  const isBusy = status === 'STARTING' || status === 'STOPPING'

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6" style={{ background: '#0f1117' }}>
      <div className="mb-8 text-center">
        <div className="flex items-center gap-2 justify-center mb-1">
          <DbIcon />
          <span className="font-semibold text-base tracking-tight" style={{ color: '#f0f6fc' }}>Migration Controller</span>
        </div>
        <p className="text-xs" style={{ color: '#6b7280' }}>Manage FlywayOps ECS task</p>
      </div>

      <div className="rounded-xl p-8 w-full max-w-xs" style={{ background: '#161b22', border: '1px solid #21262d' }}>
        {/* Status */}
        <div className="flex items-center justify-center gap-2 mb-6">
          <span className="w-2 h-2 rounded-full" style={{ background: sc.color, boxShadow: `0 0 6px ${sc.color}`, animation: sc.pulse ? 'pulse 1.5s ease-in-out infinite' : 'none' }} />
          <span className="text-sm font-mono font-bold tracking-widest" style={{ color: sc.color }}>{status}</span>
        </div>

        {/* Busy spinner */}
        {isBusy && (
          <div className="flex items-center justify-center gap-2 mb-5">
            <div className="w-3.5 h-3.5 rounded-full border-2 animate-spin" style={{ borderColor: '#f5a623', borderTopColor: 'transparent' }} />
            <span className="text-xs" style={{ color: '#6b7280' }}>
              {status === 'STARTING' ? 'Waiting for task to be ready…' : 'Stopping task…'}
            </span>
          </div>
        )}

        {/* Buttons */}
        {isStopped && (
          <button onClick={handleStart} disabled={loading}
            className="w-full py-2.5 rounded-lg font-semibold text-sm hover:opacity-90 disabled:opacity-50"
            style={{ background: '#3ecf8e', color: '#0f1117' }}>
            {loading ? 'Starting…' : 'Start App'}
          </button>
        )}
        {isRunning && (
          <button onClick={() => navigate('/dashboard')}
            className="w-full py-2.5 rounded-lg font-semibold text-sm hover:opacity-90"
            style={{ background: '#3ecf8e', color: '#0f1117' }}>
            Open Dashboard →
          </button>
        )}
        {isBusy && (
          <button disabled className="w-full py-2.5 rounded-lg font-semibold text-sm"
            style={{ background: 'transparent', border: '1px solid #30363d', color: '#6b7280' }}>
            {status === 'STARTING' ? 'Starting…' : 'Stopping…'}
          </button>
        )}

        {isRunning && (
          <button onClick={handleStop} disabled={loading} className="w-full mt-2 py-2 text-sm"
            style={{ color: '#f66070' }}>
            {loading ? 'Stopping…' : 'Stop App'}
          </button>
        )}

        {error && <p className="text-xs text-center mt-3" style={{ color: '#f66070' }}>{error}</p>}
        {lastUpd && <p className="text-xs text-center mt-4" style={{ color: '#4b5563' }}>Updated {lastUpd.toLocaleTimeString()}</p>}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button onClick={fetchStatus} className="text-xs" style={{ color: '#6b7280' }}>Refresh</button>
        <span style={{ color: '#374151' }}>·</span>
        <button onClick={() => setShowModal(true)} className="text-xs" style={{ color: '#6b7280' }}>Change API Key</button>
      </div>

      {showModal && <ApiKeyModal onSave={saveKey} canDismiss={!!apiKey} onDismiss={() => setShowModal(false)} />}
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }`}</style>
    </div>
  )
}

function DbIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3ecf8e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  )
}

// ── Router root ───────────────────────────────────────────────────────────────
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<StartScreen />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
