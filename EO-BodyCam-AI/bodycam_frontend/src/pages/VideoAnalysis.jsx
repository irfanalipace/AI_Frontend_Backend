import React, { useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { ScoreRing, SeverityBadge, Spinner, SEV } from '../components/UI'
import { ResultPanel } from './Upload'
import ApiService from '../services/api'

const SOCKET_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5050'

/**
 * Video Analysis tab.
 *
 * Drop any video / audio file into  bodycam_backend/watch/  and the
 * backend's scanner picks it up, runs the full pipeline (EO voiceprint,
 * greeting detection, transcription, tone, keywords, scoring, behavior
 * assessment, Gemini visual analysis), then exposes the result via
 * /api/watch/list  and  /api/watch/result/<id>.
 *
 * This page polls /api/watch/status + /api/watch/list every 3 s and
 * renders one card per detected file. Clicking a card opens the full
 * ResultPanel (same component the Upload tab uses).
 */

const CARD = {
  background:'#111827', border:'1px solid #1F2937',
  borderRadius:'16px', padding:'18px', marginBottom:'14px',
}
const LABEL = {
  fontSize:'10px', color:'#64748B', textTransform:'uppercase',
  letterSpacing:'0.08em', fontWeight:700, marginBottom:'10px', display:'block',
}

const STATUS_COLOR = {
  queued:    { fg:'#94A3B8', bg:'rgba(148,163,184,0.10)', border:'rgba(148,163,184,0.30)', label:'QUEUED' },
  analyzing: { fg:'#3B82F6', bg:'rgba(59,130,246,0.12)',  border:'rgba(59,130,246,0.35)',  label:'ANALYZING' },
  done:      { fg:'#10B981', bg:'rgba(16,185,129,0.10)',  border:'rgba(16,185,129,0.30)',  label:'DONE' },
  error:     { fg:'#EF4444', bg:'rgba(239,68,68,0.10)',   border:'rgba(239,68,68,0.30)',   label:'ERROR' },
}

const formatBytes = (n) => {
  if (!n) return '—'
  const mb = n / 1024 / 1024
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`
}

const formatAgo = (ts) => {
  if (!ts) return '—'
  const sec = Math.max(0, Math.round(Date.now() / 1000 - ts))
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`
  return `${Math.round(sec / 86400)}d ago`
}

export default function VideoAnalysis() {
  const [status,    setStatus]    = useState(null)
  const [items,     setItems]     = useState([])
  const [filter,    setFilter]    = useState('ALL')   // ALL | queued | analyzing | done | error
  const [sevFilter, setSevFilter] = useState('ALL')   // ALL | NORMAL | WARNING | CRITICAL
  const [busy,      setBusy]      = useState(false)
  const [openId,    setOpenId]    = useState(null)
  const [openData,  setOpenData]  = useState(null)

  // Live updates use the SocketIO push events the backend already emits
  // (watch_queued / watch_started / watch_finished / watch_failed). Polling
  // is only a slow heartbeat that fills in if the socket is disconnected,
  // and stops entirely when the tab is hidden — so the network tab stays clean.
  const inFlightRef = useRef(false)
  const abortRef    = useRef(null)
  const timerRef    = useRef(null)
  const aliveRef    = useRef(true)
  const sockRef     = useRef(null)
  const sockOkRef   = useRef(false)

  const HEARTBEAT_FAST_MS = 4000   // when socket is down
  const HEARTBEAT_SLOW_MS = 30000  // when socket is fine — just a sanity sync
  const REQ_TIMEOUT_MS    = 8000

  const upsertItem = (sum) => {
    if (!sum || !sum.file_id) return
    setItems(prev => {
      const i = prev.findIndex(x => x.file_id === sum.file_id)
      if (i === -1) return [sum, ...prev]
      const next = prev.slice()
      next[i] = { ...next[i], ...sum }
      return next
    })
  }

  const fetchAll = async () => {
    if (inFlightRef.current) return
    if (typeof document !== 'undefined' && document.hidden) return  // pause when tab hidden
    inFlightRef.current = true

    if (abortRef.current) abortRef.current.abort()
    abortRef.current = new AbortController()
    const signal = abortRef.current.signal
    const killer = setTimeout(() => abortRef.current?.abort(), REQ_TIMEOUT_MS)

    try {
      const [s, l] = await Promise.all([
        ApiService.watchStatus({ signal }),
        ApiService.watchList({}, { signal }),
      ])
      if (!aliveRef.current) return
      setStatus(s.data)
      setItems(l.data.items || [])
    } catch (e) {
      if (!aliveRef.current) return
      if (e.name !== 'CanceledError' && e.code !== 'ERR_CANCELED') {
        setStatus(prev => prev ? { ...prev, _offline: true } : { _offline: true })
      }
    } finally {
      clearTimeout(killer)
      inFlightRef.current = false
      if (aliveRef.current) {
        const delay = sockOkRef.current ? HEARTBEAT_SLOW_MS : HEARTBEAT_FAST_MS
        timerRef.current = setTimeout(fetchAll, delay)
      }
    }
  }

  useEffect(() => {
    aliveRef.current = true

    // ── SocketIO push subscription ─────────────────────────────────
    const sock = io(SOCKET_BASE, { transports: ['websocket', 'polling'] })
    sockRef.current = sock
    sock.on('connect',    () => { sockOkRef.current = true })
    sock.on('disconnect', () => { sockOkRef.current = false })
    sock.on('watch_queued',   upsertItem)
    sock.on('watch_started',  upsertItem)
    sock.on('watch_finished', upsertItem)
    sock.on('watch_failed',   upsertItem)

    // ── Initial load + heartbeat ───────────────────────────────────
    fetchAll()

    // ── Pause / resume on tab visibility ───────────────────────────
    const onVisibility = () => {
      if (!document.hidden && aliveRef.current && !inFlightRef.current) {
        if (timerRef.current) clearTimeout(timerRef.current)
        fetchAll()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      aliveRef.current = false
      document.removeEventListener('visibilitychange', onVisibility)
      if (timerRef.current) clearTimeout(timerRef.current)
      if (abortRef.current) abortRef.current.abort()
      try { sock.disconnect() } catch {}
    }
  }, [])

  const rescan = async () => {
    setBusy(true)
    try { await ApiService.watchRescan(); await fetchAll() }
    finally { setBusy(false) }
  }

  const openDetails = async (item) => {
    setOpenId(item.file_id)
    setOpenData(null)
    try {
      const r = await ApiService.watchResult(item.file_id)
      setOpenData(r.data)
    } catch (_e) {
      setOpenData({ error: 'Could not fetch full result' })
    }
  }

  const closeDetails = () => { setOpenId(null); setOpenData(null) }

  const remove = async (id, e) => {
    e?.stopPropagation()
    if (!window.confirm('Remove this entry from the dashboard? (the video file is kept)')) return
    await ApiService.watchDelete(id)
    setItems(prev => prev.filter(x => x.file_id !== id))
  }

  // Filter
  const visible = items.filter(i =>
    (filter === 'ALL' || i.status === filter) &&
    (sevFilter === 'ALL' || (i.severity || '') === sevFilter)
  )

  const counts = status?.counts || {}
  const sevCounts = items.reduce((acc, i) => {
    const k = i.severity || 'PENDING'
    acc[k] = (acc[k] || 0) + 1
    return acc
  }, {})

  return (
    <div style={{ padding:'30px', maxWidth:'1400px' }}>

      {/* Header */}
      <div style={{ marginBottom:'20px' }}>
        <h1 style={{ fontSize:'24px', fontWeight:800, color:'#F1F5F9',
          margin:'0 0 6px', letterSpacing:'-0.02em' }}>
          Video Analysis · Auto Watch Folder
        </h1>
        <p style={{ fontSize:'13px', color:'#64748B', lineHeight:1.6, margin:0 }}>
          Drop any video / audio file into the watch folder below — the server
          detects it automatically, runs the full pipeline, and shows the result here.
          No upload step, no clicks.
        </p>
      </div>

      {/* Watcher status banner */}
      <div style={{ ...CARD,
        background: status?._offline
          ? 'rgba(239,68,68,0.06)'
          : 'linear-gradient(135deg, rgba(59,130,246,0.06), rgba(16,185,129,0.04))',
        border: status?._offline
          ? '1px solid rgba(239,68,68,0.25)'
          : '1px solid rgba(59,130,246,0.2)' }}>
        <div style={{ display:'flex', alignItems:'center', gap:'14px', flexWrap:'wrap' }}>
          <div style={{ width:42, height:42, borderRadius:'12px',
            background: status?._offline ? '#1F2937'
                        : status?.running ? 'linear-gradient(135deg, #10B981, #059669)'
                        : '#1F2937',
            display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:'18px', fontWeight:800, color:'#fff',
            boxShadow:'0 4px 12px rgba(16,185,129,0.25)' }}>
            {status?._offline ? '✕' : status?.running ? '●' : '○'}
          </div>
          <div style={{ flex:1, minWidth:'260px' }}>
            <div style={{ fontSize:'13px', fontWeight:700, color:'#F1F5F9', marginBottom:'2px' }}>
              {status?._offline ? 'Backend offline' :
                status?.running ? 'Watcher running' : 'Watcher paused'}
            </div>
            <div style={{ fontSize:'11px', color:'#64748B', wordBreak:'break-all' }}>
              {status?.folder || 'bodycam_backend/watch/'}
            </div>
          </div>
          <div style={{ display:'flex', gap:'10px', flexWrap:'wrap' }}>
            <KPI label="Total"     value={counts.total ?? 0}     color="#94A3B8"/>
            <KPI label="In Queue"  value={counts.queued ?? 0}    color="#94A3B8"/>
            <KPI label="Analyzing" value={counts.analyzing ?? 0} color="#3B82F6"/>
            <KPI label="Done"      value={counts.done ?? 0}      color="#10B981"/>
            <KPI label="Errors"    value={counts.error ?? 0}     color="#EF4444"/>
          </div>
          <button onClick={rescan} disabled={busy}
            style={{ padding:'10px 16px', borderRadius:'10px', fontSize:'12px',
              fontWeight:700, color:'#fff',
              background: busy ? '#1F2937' : 'linear-gradient(135deg, #3B82F6, #6366F1)',
              border:'none', cursor: busy ? 'not-allowed' : 'pointer',
              display:'flex', alignItems:'center', gap:'8px' }}>
            {busy ? <Spinner size={12} color="#fff"/> : '↻'}
            Rescan now
          </button>
        </div>
        {status?.last_scan ? (
          <div style={{ marginTop:'10px', fontSize:'10px', color:'#475569',
            display:'flex', gap:'14px', flexWrap:'wrap' }}>
            <span>Last scan: {formatAgo(status.last_scan)}</span>
            <span>Interval: every {status.scan_every || 3}s</span>
            <span>Default officer: {status.default_officer_id || 'EO_001'}</span>
            <span>Done folder: {status.done_folder}</span>
          </div>
        ) : null}
      </div>

      {/* Severity breakdown */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:'10px',
        marginBottom:'14px' }}>
        {[
          { sev:'CRITICAL', count: sevCounts.CRITICAL || 0 },
          { sev:'WARNING',  count: sevCounts.WARNING  || 0 },
          { sev:'NORMAL',   count: sevCounts.NORMAL   || 0 },
          { sev:'PENDING',  count: sevCounts.PENDING  || 0 },
        ].map(s => {
          const cfg = SEV[s.sev] || SEV.NORMAL
          const isPending = s.sev === 'PENDING'
          return (
            <div key={s.sev} style={{
              background: isPending ? '#111827' : cfg.bg,
              border: isPending ? '1px solid #1F2937' : `1px solid ${cfg.border}`,
              borderRadius:'14px', padding:'16px' }}>
              <div style={{ fontSize:'10px', color:'#64748B', textTransform:'uppercase',
                fontWeight:700, letterSpacing:'0.08em', marginBottom:'6px' }}>
                {s.sev}
              </div>
              <div style={{ fontSize:'26px', fontWeight:900,
                color: isPending ? '#94A3B8' : cfg.text }}>
                {s.count}
              </div>
            </div>
          )
        })}
      </div>

      {/* Filter row */}
      <div style={{ display:'flex', gap:'8px', marginBottom:'14px', flexWrap:'wrap' }}>
        {['ALL', 'queued', 'analyzing', 'done', 'error'].map(f => (
          <FilterPill key={f} label={f.toUpperCase()} active={filter === f}
            onClick={() => setFilter(f)}/>
        ))}
        <span style={{ width:'1px', background:'#1F2937', margin:'0 4px' }}/>
        {['ALL', 'CRITICAL', 'WARNING', 'NORMAL'].map(f => (
          <FilterPill key={f} label={f} active={sevFilter === f}
            onClick={() => setSevFilter(f)}/>
        ))}
      </div>

      {/* Cards */}
      {visible.length === 0 ? (
        <div style={{ ...CARD, textAlign:'center', padding:'60px 30px' }}>
          <div style={{ fontSize:'34px', color:'#2D3348', marginBottom:'14px' }}>📂</div>
          <div style={{ fontSize:'14px', fontWeight:700, color:'#94A3B8', marginBottom:'6px' }}>
            {items.length === 0 ? 'Watch folder is empty'
              : 'No videos match the selected filters'}
          </div>
          <div style={{ fontSize:'12px', color:'#475569', lineHeight:1.7 }}>
            {items.length === 0 ? (
              <>Drop a video file into <code style={{ color:'#3B82F6' }}>
                {status?.folder || 'bodycam_backend/watch/'}
              </code><br/>and it will be analyzed automatically.</>
            ) : 'Try clearing the status / severity filters.'}
          </div>
        </div>
      ) : (
        <div style={{ display:'grid',
          gridTemplateColumns:'repeat(auto-fill, minmax(360px, 1fr))', gap:'14px' }}>
          {visible.map(item => (
            <VideoCard key={item.file_id} item={item}
              onOpen={() => openDetails(item)}
              onRemove={(e) => remove(item.file_id, e)}/>
          ))}
        </div>
      )}

      {/* Details modal */}
      {openId && (
        <DetailsModal data={openData} onClose={closeDetails}/>
      )}
    </div>
  )
}


// ── Sub-components ────────────────────────────────────────────────────

function KPI({ label, value, color }) {
  return (
    <div style={{ background:'rgba(15,23,42,0.6)', borderRadius:'10px',
      padding:'8px 14px', border:'1px solid #1F2937', minWidth:'72px',
      textAlign:'center' }}>
      <div style={{ fontSize:'9px', color:'#64748B', fontWeight:700,
        textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:'2px' }}>
        {label}
      </div>
      <div style={{ fontSize:'18px', fontWeight:800, color }}>{value}</div>
    </div>
  )
}

function FilterPill({ label, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding:'7px 14px', borderRadius:'8px', fontSize:'11px', fontWeight:700,
      letterSpacing:'0.04em',
      background: active ? 'rgba(59,130,246,0.15)' : '#0B0F1A',
      border: `1px solid ${active ? 'rgba(59,130,246,0.4)' : '#1F2937'}`,
      color: active ? '#3B82F6' : '#94A3B8',
      cursor:'pointer', transition:'all .2s',
    }}>
      {label}
    </button>
  )
}

function VideoCard({ item, onOpen, onRemove }) {
  const stat = STATUS_COLOR[item.status] || STATUS_COLOR.queued
  const sev = item.severity
  const sevCfg = sev ? (SEV[sev] || SEV.NORMAL) : null
  const score = item.total_score ?? 0
  const violations = item.top_violations || []
  const isAnalyzing = item.status === 'analyzing'
  const isPulsing = sev === 'CRITICAL'

  return (
    <div onClick={onOpen}
      style={{
        background:'#111827',
        border: sev === 'CRITICAL' ? '1px solid rgba(239,68,68,0.45)'
              : sev === 'WARNING' ? '1px solid rgba(245,158,11,0.30)'
              : '1px solid #1F2937',
        borderRadius:'14px', padding:'16px', cursor:'pointer',
        transition:'all .2s', position:'relative', overflow:'hidden',
        animation: isPulsing ? 'criticalPulse 3s infinite' : 'none',
      }}
      onMouseEnter={e => e.currentTarget.style.transform = 'translateY(-2px)'}
      onMouseLeave={e => e.currentTarget.style.transform = 'translateY(0)'}>

      {/* Top row: status + severity + remove */}
      <div style={{ display:'flex', justifyContent:'space-between',
        alignItems:'flex-start', gap:'8px', marginBottom:'10px' }}>
        <span style={{
          padding:'3px 10px', borderRadius:'6px', fontSize:'9px',
          fontWeight:800, letterSpacing:'0.06em',
          color: stat.fg, background: stat.bg, border: `1px solid ${stat.border}`,
          display:'inline-flex', alignItems:'center', gap:'6px',
        }}>
          {isAnalyzing && <Spinner size={8} color={stat.fg}/>}
          {stat.label}
        </span>
        <div style={{ display:'flex', gap:'6px', alignItems:'center' }}>
          {sevCfg && <SeverityBadge severity={sev}/>}
          <button onClick={onRemove} title="Remove from list"
            style={{ background:'transparent', border:'none', color:'#475569',
              fontSize:'14px', cursor:'pointer', padding:'2px 6px' }}>
            ✕
          </button>
        </div>
      </div>

      {/* Filename */}
      <div style={{ fontSize:'13px', fontWeight:700, color:'#F1F5F9',
        marginBottom:'4px', wordBreak:'break-all', lineHeight:1.4 }}>
        {item.filename}
      </div>
      <div style={{ fontSize:'10px', color:'#64748B', marginBottom:'12px' }}>
        {item.media_type === 'video' ? '🎬 Video' : '🎙 Audio'} ·
        {' '}{formatBytes(item.size_bytes)} ·
        {' '}{item.duration_sec ? `${item.duration_sec.toFixed(1)}s` : '—'} ·
        {' '}{formatAgo(item.finished_at || item.started_at || item.queued_at)}
      </div>

      {/* Body — analyzing skeleton vs done content vs error */}
      {item.status === 'queued' && (
        <div style={{ fontSize:'11px', color:'#64748B', fontStyle:'italic' }}>
          Waiting for the worker thread…
        </div>
      )}

      {isAnalyzing && (
        <div style={{ display:'flex', alignItems:'center', gap:'10px',
          background:'rgba(59,130,246,0.06)', borderRadius:'10px',
          padding:'12px', border:'1px solid rgba(59,130,246,0.2)' }}>
          <Spinner size={18} color="#3B82F6"/>
          <div style={{ fontSize:'11px', color:'#3B82F6', fontWeight:600 }}>
            Running pipeline — voiceprint · greeting · transcription · tone · keywords · score
          </div>
        </div>
      )}

      {item.status === 'error' && (
        <div style={{ fontSize:'11px', color:'#EF4444',
          background:'rgba(239,68,68,0.08)', borderRadius:'10px',
          padding:'10px 12px', border:'1px solid rgba(239,68,68,0.25)' }}>
          {item.error || 'Pipeline error'}
        </div>
      )}

      {item.status === 'done' && (
        <>
          <div style={{ display:'flex', gap:'14px', alignItems:'center',
            marginBottom:'12px' }}>
            <ScoreRing score={score} severity={sev || 'NORMAL'} size={72}/>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:'10px', color:'#64748B', fontWeight:700,
                textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:'4px' }}>
                Officer
              </div>
              <div style={{ fontSize:'12px', fontWeight:700, color:'#F1F5F9' }}>
                {item.officer_name || item.officer_id || 'Unknown'}
              </div>
              {item.officer_badge && (
                <div style={{ fontSize:'10px', color:'#64748B', marginTop:'2px' }}>
                  {item.officer_badge}
                </div>
              )}
              <div style={{ marginTop:'6px', display:'flex', gap:'10px',
                fontSize:'10px', color:'#64748B' }}>
                <span>Tone {item.tone_score ?? 0}</span>
                <span>·</span>
                <span>Keywords {item.keyword_score ?? 0}</span>
              </div>
            </div>
          </div>

          {violations.length > 0 && (
            <div style={{ marginBottom:'10px' }}>
              <div style={LABEL}>Top violations</div>
              <div style={{ display:'flex', flexWrap:'wrap', gap:'4px' }}>
                {violations.map((v, i) => (
                  <span key={i} style={{
                    fontSize:'10px', fontWeight:600,
                    padding:'3px 8px', borderRadius:'6px',
                    color:'#EF4444', background:'rgba(239,68,68,0.10)',
                    border:'1px solid rgba(239,68,68,0.25)',
                  }}>
                    {(v.label || v.type || '').replace(/_/g,' ')}
                  </span>
                ))}
                {item.violations_count > violations.length && (
                  <span style={{ fontSize:'10px', color:'#64748B', fontWeight:600,
                    padding:'3px 6px' }}>
                    +{item.violations_count - violations.length} more
                  </span>
                )}
              </div>
            </div>
          )}

          {item.transcript_preview && (
            <div style={{ fontSize:'11px', color:'#94A3B8', lineHeight:1.5,
              background:'rgba(15,23,42,0.6)', borderRadius:'8px',
              padding:'10px 12px', border:'1px solid #1F2937',
              maxHeight:'72px', overflow:'hidden', position:'relative' }}>
              <div style={{ fontSize:'9px', color:'#64748B', fontWeight:700,
                textTransform:'uppercase', letterSpacing:'0.07em',
                marginBottom:'4px' }}>
                Transcript preview
              </div>
              <div style={{ fontStyle:'italic' }}>
                "{item.transcript_preview}…"
              </div>
            </div>
          )}

          <div style={{ marginTop:'10px', textAlign:'center', fontSize:'10px',
            color:'#3B82F6', fontWeight:600 }}>
            Click to view full assessment →
          </div>
        </>
      )}
    </div>
  )
}

function DetailsModal({ data, onClose }) {
  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div onClick={onClose} style={{
      position:'fixed', inset:0, background:'rgba(11,15,26,0.85)',
      backdropFilter:'blur(4px)', zIndex:1000, padding:'24px',
      overflowY:'auto', display:'flex', justifyContent:'center',
      alignItems:'flex-start',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width:'100%', maxWidth:'1000px', background:'#0B0F1A',
        border:'1px solid #1F2937', borderRadius:'16px',
        padding:'24px', position:'relative', minHeight:'200px',
      }}>
        <button onClick={onClose} style={{
          position:'absolute', top:'14px', right:'14px',
          background:'#1F2937', border:'1px solid #2D3348',
          color:'#94A3B8', borderRadius:'8px', padding:'6px 12px',
          fontSize:'12px', fontWeight:700, cursor:'pointer',
        }}>
          Close · Esc
        </button>

        {!data && (
          <div style={{ textAlign:'center', padding:'60px 20px' }}>
            <Spinner size={32} color="#3B82F6"/>
            <div style={{ fontSize:'13px', color:'#94A3B8', marginTop:'14px' }}>
              Loading full result…
            </div>
          </div>
        )}

        {data?.error && (
          <div style={{ padding:'40px 20px', textAlign:'center', color:'#EF4444' }}>
            {data.error}
          </div>
        )}

        {data && data.result && (
          <>
            <div style={{ fontSize:'10px', color:'#64748B', fontWeight:700,
              textTransform:'uppercase', letterSpacing:'0.07em', marginBottom:'4px' }}>
              {data.filename}
            </div>
            <h2 style={{ fontSize:'18px', fontWeight:800, color:'#F1F5F9',
              marginBottom:'18px' }}>
              Full Analysis · {data.result.severity || 'PENDING'}
            </h2>
            <ResultPanel result={data.result}/>
          </>
        )}

        {data && !data.result && !data.error && (
          <div style={{ padding:'40px 20px', textAlign:'center', color:'#94A3B8',
            fontSize:'13px' }}>
            This file is still {data.status}. Try again in a moment.
          </div>
        )}
      </div>
    </div>
  )
}
