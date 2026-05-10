import React, { useEffect, useRef, useState } from 'react'
import { ScoreRing, SeverityBadge, Spinner, SEV } from '../components/UI'
import IncidentDetailModal from '../components/IncidentDetailModal'
import ApiService from '../services/api'

/**
 * Video Analysis tab — DB-backed.
 *
 * Drop any video / audio file into  bodycam_dotnet/WatchFolder/Inbox/
 * and the .NET background watcher (VideoFolderWatcherService) picks it up,
 * extracts audio with ffmpeg, forwards it to the Python ML pipeline for
 * Gemini analysis, then persists the rich result to MSSQL
 * (dbo.recordings / dbo.analysis_results / dbo.violations).
 *
 * This page reads two .NET endpoints:
 *   GET /api/watch-folder/status   — live counters + recent in-flight items
 *   GET /api/recordings            — durable list from MSSQL
 *
 * Items survive Python or .NET restarts because the source of truth is the DB.
 */

const CARD = {
  background: 'linear-gradient(180deg, #111827 0%, #0F172A 100%)',
  border: '1px solid rgba(51, 65, 85, 0.4)',
  borderRadius: '16px', padding: '20px', marginBottom: '16px',
  boxShadow: '0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 24px rgba(0,0,0,0.18)',
}
const LABEL = {
  fontSize: '10px', color: '#64748B', textTransform: 'uppercase',
  letterSpacing: '0.10em', fontWeight: 700, marginBottom: '10px', display: 'block',
}

const STATUS_COLOR = {
  queued:    { fg: '#94A3B8', bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.30)', glow: 'rgba(148,163,184,0.20)', label: 'QUEUED',    icon: '⏱' },
  analyzing: { fg: '#60A5FA', bg: 'rgba(59,130,246,0.12)',  border: 'rgba(59,130,246,0.40)',  glow: 'rgba(59,130,246,0.30)',  label: 'ANALYZING', icon: '⟳' },
  done:      { fg: '#34D399', bg: 'rgba(16,185,129,0.10)',  border: 'rgba(16,185,129,0.35)',  glow: 'rgba(16,185,129,0.25)',  label: 'DONE',      icon: '✓' },
  error:     { fg: '#F87171', bg: 'rgba(239,68,68,0.10)',   border: 'rgba(239,68,68,0.35)',   glow: 'rgba(239,68,68,0.30)',   label: 'ERROR',     icon: '!' },
}

const formatBytes = (n) => {
  if (!n) return '—'
  const mb = n / 1024 / 1024
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`
}

const formatAgo = (input) => {
  if (!input) return '—'
  const ts = typeof input === 'number'
    ? input
    : Math.round(new Date(input).getTime() / 1000)
  if (!Number.isFinite(ts)) return '—'
  const sec = Math.max(0, Math.round(Date.now() / 1000 - ts))
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`
  return `${Math.round(sec / 86400)}d ago`
}

// Convert an ISO date string (.NET serialises DateTime as ISO 8601) to
// seconds-since-epoch so the existing formatAgo helper Just Works.
const isoToEpoch = (iso) => {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? Math.round(t / 1000) : null
}

// ── Adapter: .NET RecordingListItem → card item shape ─────────────────
// The DB list endpoint already exposes everything the card needs except
// transcript_preview / top_violations (those live on the detail row and
// would balloon the list payload).  The detail modal still gets the full
// rich result.
const recordingToItem = (r) => ({
  file_id:          `db-${r.id}`,
  recording_id:     r.id,
  filename:         r.filename,
  status:           'done',
  severity:         r.severity || 'NORMAL',
  total_score:      r.score ?? 0,
  tone_score:       0,                 // not surfaced on the list endpoint
  keyword_score:    0,                 // not surfaced on the list endpoint
  officer_id:       r.officerId,
  officer_name:     r.officerId,        // list endpoint doesn't include officer name
  officer_badge:    null,
  media_type:       r.mediaType || 'video',
  size_bytes:       null,
  duration_sec:     r.durationSeconds || 0,
  finished_at:      isoToEpoch(r.uploadedAt),
  started_at:       isoToEpoch(r.uploadedAt),
  queued_at:        isoToEpoch(r.uploadedAt),
  violations_count: r.violationCount ?? 0,
  top_violations:   [],                 // surfaced in the modal, not on the card
  transcript_preview: null,
  tone_label:       r.toneLabel || 'NORMAL',
})

// ── Adapter: .NET WatchFolder recent item → card item shape ──────────
// SUCCESS items are skipped — they appear via the recordings list (with
// richer detail). STARTED items become live "ANALYZING" cards. FAILED
// items become "ERROR" cards. Both are ephemeral — gone on next refresh
// once the file finishes processing or another file fails.
const recentToItem = (recent) => {
  const at = isoToEpoch(recent.at)
  if (recent.status === 'STARTED') {
    return {
      file_id:    `live-${recent.filename}-${at}`,
      filename:   recent.filename,
      status:     'analyzing',
      severity:   null,
      started_at: at,
      queued_at:  at,
      media_type: 'video',
    }
  }
  if (recent.status === 'FAILED') {
    return {
      file_id:    `fail-${recent.filename}-${at}`,
      filename:   recent.filename,
      status:     'error',
      error:      recent.error || 'Pipeline error',
      finished_at: at,
      media_type: 'video',
    }
  }
  return null
}

export default function VideoAnalysis() {
  const [status,    setStatus]    = useState(null)
  const [items,     setItems]     = useState([])
  const [filter,    setFilter]    = useState('ALL')
  const [sevFilter, setSevFilter] = useState('ALL')
  const [busy,      setBusy]      = useState(false)
  // Modal: holds the numeric recording_id of the row currently opened.
  // Live ANALYZING / ERROR rows have no DB id yet — we show an inline
  // toast for those instead of opening the rich modal.
  const [openId,    setOpenId]    = useState(null)
  const [openToast, setOpenToast] = useState(null)
  const [search,    setSearch]    = useState('')           // filename text search
  const [sortBy,    setSortBy]    = useState('newest')     // newest | oldest | score | severity

  const inFlightRef = useRef(false)
  const abortRef    = useRef(null)
  const timerRef    = useRef(null)
  const aliveRef    = useRef(true)
  const tickRef     = useRef(0)
  const recordingsCacheRef = useRef([])

  // Adaptive polling — the goal is to stop hammering the network when nothing
  // is actually happening:
  //
  //   in_flight > 0  (watcher is processing a file):
  //     status      every 6s   — user wants to see ANALYZING progress
  //     recordings  every 18s  (every 3rd tick)
  //
  //   in_flight = 0  (idle):
  //     status      every 60s  — slow heartbeat, network tab stays clean
  //     recordings  every 120s (every 2nd tick)
  //
  // Whenever a SUCCESS or FAILED entry appears that we haven't seen, the
  // recordings list is force-refreshed on the next tick so the ANALYZING
  // card flips to DONE within seconds, not minutes.
  const ACTIVE_HEARTBEAT_MS = 6000
  const IDLE_HEARTBEAT_MS   = 60000
  const ACTIVE_RECORDINGS_TICKS = 3   // 6s × 3 = 18s
  const IDLE_RECORDINGS_TICKS   = 2   // 60s × 2 = 120s
  const REQ_TIMEOUT_MS = 8000

  const isIdleRef = useRef(true)

  const fetchAll = async () => {
    if (inFlightRef.current) return
    if (typeof document !== 'undefined' && document.hidden) return
    inFlightRef.current = true

    if (abortRef.current) abortRef.current.abort()
    abortRef.current = new AbortController()
    const signal = abortRef.current.signal
    const killer = setTimeout(() => abortRef.current?.abort(), REQ_TIMEOUT_MS)

    const tick = ++tickRef.current
    const recordingsTicks = isIdleRef.current ? IDLE_RECORDINGS_TICKS : ACTIVE_RECORDINGS_TICKS
    const fetchRecordings =
      tick === 1 ||
      tick % recordingsTicks === 0

    try {
      const watchPromise = ApiService.dotnetWatchStatus({ signal })
      const recordingsPromise = fetchRecordings
        ? ApiService.dotnetRecordings({ page: 1, pageSize: 50 }, { signal })
        : Promise.resolve(null)

      const [s, l] = await Promise.all([watchPromise, recordingsPromise])
      if (!aliveRef.current) return

      const watchData = s.data || {}

      // If we did not refetch the recordings list this tick, reuse the cached
      // copy. But: if /watch-folder/status reports a NEW success/failure since
      // last tick, force-refresh the list immediately on the next tick.
      let recordings
      if (l) {
        recordings = (l.data?.items || []).map(recordingToItem)
        recordingsCacheRef.current = recordings
      } else {
        recordings = recordingsCacheRef.current
      }

      // If the watcher just finished a file (SUCCESS in recent), the new DB
      // row may not yet be in our cached recordings list. Schedule the next
      // tick to refresh recordings so the ANALYZING card flips to DONE
      // promptly instead of waiting up to 24s for the regular tick.
      const sawNewSuccess = (watchData.recent || []).some(r =>
        r.status === 'SUCCESS' && r.recordingId &&
        !recordingsCacheRef.current.some(x => x.recording_id === r.recordingId)
      )
      if (sawNewSuccess) {
        tickRef.current = RECORDINGS_EVERY_N_TICKS - 1   // forces refresh next tick
      }

      const live = (watchData.recent || [])
        .map(recentToItem)
        .filter(Boolean)

      // Merge: live ANALYZING/ERROR cards on top, durable DB cards below.
      // De-dup by filename so a STARTED item disappears as soon as its
      // matching DB row arrives.
      const dbFilenames = new Set(recordings.map(r => r.filename))
      const filteredLive = live.filter(i => i.status === 'error' || !dbFilenames.has(i.filename))

      // The .NET WatchFolderController returns an anonymous object with
      // explicit snake_case keys (inbox_path, poll_seconds, in_flight, …),
      // so the global camelCase JsonNamingPolicy does NOT mangle them.
      // The `recent` array on the other hand holds PascalCase entities and
      // therefore IS camelCased — Filename → filename, RecordingId → recordingId.
      const c = watchData.counters || {}
      // Idle = no files currently being processed AND no recent ANALYZING
      // entries. Switching to idle slows the poll cadence dramatically so the
      // network tab stays clean when nothing is happening.
      const inFlight = c.in_flight || 0
      const hasLive = (watchData.recent || []).some(r => r.status === 'STARTED')
      isIdleRef.current = inFlight === 0 && !hasLive

      setStatus({
        running:           watchData.enabled,
        folder:            watchData.inbox_path || watchData.watch_path || 'WatchFolder/Inbox/',
        done_folder:       watchData.processed_path,
        scan_every:        watchData.poll_seconds,
        default_officer_id: watchData.default_officer,
        last_scan:         Math.round(Date.now() / 1000),
        counts: {
          total:     (c.processed || 0) + (c.failed || 0),
          queued:    0,
          analyzing: c.in_flight || 0,
          done:      c.processed || 0,
          error:     c.failed || 0,
        },
      })
      setItems([...filteredLive, ...recordings])
    } catch (e) {
      if (!aliveRef.current) return
      if (e.name !== 'CanceledError' && e.code !== 'ERR_CANCELED') {
        setStatus(prev => prev ? { ...prev, _offline: true } : { _offline: true })
      }
    } finally {
      clearTimeout(killer)
      inFlightRef.current = false
      if (aliveRef.current) {
        const next = isIdleRef.current ? IDLE_HEARTBEAT_MS : ACTIVE_HEARTBEAT_MS
        timerRef.current = setTimeout(fetchAll, next)
      }
    }
  }

  useEffect(() => {
    aliveRef.current = true
    fetchAll()

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
    }
  }, [])

  const rescan = async () => {
    setBusy(true)
    try { await ApiService.dotnetWatchTrigger(); await fetchAll() }
    catch (_e) { /* triggered status is reflected on next poll */ }
    finally { setBusy(false) }
  }

  // ── Open detail modal ─────────────────────────────────────────────
  // For DB-backed rows we just hand the numeric recording_id to the
  // shared IncidentDetailModal — it fetches its own data so this page
  // no longer needs to know the .NET DTO shape.  Live ANALYZING /
  // ERROR rows show a small toast instead.
  const openDetails = (item) => {
    if (!item.recording_id) {
      setOpenToast({
        filename: item.filename,
        message: item.error || 'No DB record yet — analysis still in progress.',
      })
      window.setTimeout(() => setOpenToast(null), 3500)
      return
    }
    setOpenId(item.recording_id)
  }

  const closeDetails = () => setOpenId(null)

  const remove = async (item, e) => {
    e?.stopPropagation()
    // Live ANALYZING / ERROR cards have no DB row yet — just hide them
    // locally; the next poll will bring them back if .NET still reports them.
    if (!item.recording_id) {
      setItems(prev => prev.filter(x => x.file_id !== item.file_id))
      return
    }
    if (!window.confirm(
      `Permanently delete "${item.filename}" from the database? ` +
      `This removes the analysis row and all its violations. ` +
      `The original file in WatchFolder/Processed/ is kept.`
    )) return
    try {
      const resp = await ApiService.dotnetDeleteRecording(item.recording_id)
      console.log('[delete] OK', { id: item.recording_id, status: resp?.status })
      setItems(prev => prev.filter(x => x.file_id !== item.file_id))
    } catch (e) {
      // Show the real reason in the alert — most common cause is the .NET
      // API still running the OLD binary (before the DELETE endpoint was
      // added) → 404 / "Network Error". Also logs full error to console
      // so we can see CORS preflight, body, etc.
      console.error('[delete] FAILED', e)
      const status = e?.response?.status
      const body   = e?.response?.data
      const url    = e?.config?.baseURL ? e.config.baseURL + e.config.url : (e?.config?.url || '')
      const detail = status
        ? `HTTP ${status} from ${url}\n${typeof body === 'string' ? body : JSON.stringify(body || {})}`
        : `${e?.code || 'Network error'}: ${e?.message || 'unknown'}\nTarget: ${url}\n\n` +
          `Most likely the .NET API is still running the OLD binary without the\n` +
          `DELETE endpoint. Stop it (Ctrl+C in its terminal) and restart with:\n` +
          `  cd c:/Projects/bodycam_dotnet\n` +
          `  dotnet run --project PERA360.Api`
      window.alert('Could not delete the recording.\n\n' + detail)
    }
  }

  // Filter by status, severity, and search text (filename match)
  const filtered = items.filter(i => {
    if (filter !== 'ALL' && i.status !== filter) return false
    if (sevFilter !== 'ALL' && (i.severity || '') !== sevFilter) return false
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      const fn = (i.filename || '').toLowerCase()
      const off = (i.officer_name || i.officer_id || '').toLowerCase()
      if (!fn.includes(q) && !off.includes(q)) return false
    }
    return true
  })

  // Sort the filtered items per user choice
  const sevRank = { CRITICAL: 0, WARNING: 1, NORMAL: 2, '': 3 }
  const visible = [...filtered].sort((a, b) => {
    if (sortBy === 'newest') {
      return (b.finished_at || b.started_at || 0) - (a.finished_at || a.started_at || 0)
    }
    if (sortBy === 'oldest') {
      return (a.finished_at || a.started_at || 0) - (b.finished_at || b.started_at || 0)
    }
    if (sortBy === 'score') {
      return (b.total_score ?? 0) - (a.total_score ?? 0)
    }
    if (sortBy === 'severity') {
      return (sevRank[a.severity || ''] ?? 99) - (sevRank[b.severity || ''] ?? 99)
    }
    return 0
  })

  // Group items by recency for visual headers
  const now = Date.now() / 1000
  const groupOf = (i) => {
    const ts = i.finished_at || i.started_at || i.queued_at
    if (!ts) return 'Older'
    const ageH = (now - ts) / 3600
    if (ageH < 12) return 'Today'
    if (ageH < 36) return 'Yesterday'
    if (ageH < 24 * 7) return 'This Week'
    return 'Older'
  }
  const grouped = (sortBy === 'newest' || sortBy === 'oldest')
    ? visible.reduce((acc, item) => {
        const g = groupOf(item)
        if (!acc[g]) acc[g] = []
        acc[g].push(item)
        return acc
      }, {})
    : null  // No grouping when sorted by score/severity

  // Counts for filter pill badges
  const statusCounts = items.reduce((a, i) => {
    a[i.status] = (a[i.status] || 0) + 1
    a.ALL = (a.ALL || 0) + 1
    return a
  }, {})
  const sevFilterCounts = items.reduce((a, i) => {
    const k = i.severity || ''
    if (k) a[k] = (a[k] || 0) + 1
    a.ALL = (a.ALL || 0) + 1
    return a
  }, {})

  const counts = status?.counts || {}
  const sevCounts = items.reduce((acc, i) => {
    const k = i.severity || 'PENDING'
    acc[k] = (acc[k] || 0) + 1
    return acc
  }, {})

  return (
    <div style={{ padding:'32px 36px', maxWidth:'1440px' }}>
      {/* Inline animation styles — keeps the page self-contained */}
      <style>{`
        @keyframes va-fadeIn { from { opacity:0; transform: translateY(6px); } to { opacity:1; transform: translateY(0); } }
        @keyframes va-pulse  { 0%,100% { opacity:0.5; } 50% { opacity:1; } }
        @keyframes va-slideUp { from { opacity:0; transform: translateY(12px); } to { opacity:1; transform: translateY(0); } }
        .va-card-anim { animation: va-slideUp .35s cubic-bezier(0.4, 0, 0.2, 1) both; }
        .va-fade { animation: va-fadeIn .25s ease-out both; }
      `}</style>

      {/* Header — refined gradient title */}
      <div style={{ marginBottom:'24px' }}>
        <div style={{ display:'flex', alignItems:'center', gap:'12px', marginBottom:'8px' }}>
          <div style={{
            width:'4px', height:'28px', borderRadius:'4px',
            background:'linear-gradient(180deg, #60A5FA, #6366F1)',
            boxShadow:'0 0 12px rgba(96,165,250,0.5)',
          }}/>
          <h1 style={{ fontSize:'26px', fontWeight:800,
            background:'linear-gradient(135deg, #F1F5F9 0%, #94A3B8 100%)',
            WebkitBackgroundClip:'text', backgroundClip:'text',
            WebkitTextFillColor:'transparent',
            margin:0, letterSpacing:'-0.025em' }}>
            Video Analysis
          </h1>
          <span style={{
            fontSize:'10px', fontWeight:700, color:'#60A5FA',
            background:'rgba(96,165,250,0.10)', border:'1px solid rgba(96,165,250,0.25)',
            padding:'4px 10px', borderRadius:'6px', letterSpacing:'0.08em',
          }}>
            AUTO WATCH FOLDER
          </span>
        </div>
        <p style={{ fontSize:'13px', color:'#64748B', lineHeight:1.7,
          margin:'0 0 0 16px', maxWidth:'920px' }}>
          Drop any video or audio file into the watch folder below — the system detects
          it automatically, extracts audio, runs Gemini AI analysis, and persists results
          to MSSQL. The list below is read straight from the database and survives restarts.
        </p>
      </div>

      {/* Watcher status banner — premium gradient + glassmorphism */}
      <div style={{
        position:'relative', overflow:'hidden',
        background: status?._offline
          ? 'linear-gradient(135deg, rgba(239,68,68,0.08) 0%, rgba(15,23,42,0.4) 100%)'
          : 'linear-gradient(135deg, rgba(59,130,246,0.10) 0%, rgba(16,185,129,0.05) 50%, rgba(15,23,42,0.4) 100%)',
        border: status?._offline
          ? '1px solid rgba(239,68,68,0.25)'
          : '1px solid rgba(96,165,250,0.20)',
        borderRadius:'20px', padding:'22px 24px', marginBottom:'18px',
        boxShadow:'0 1px 0 rgba(255,255,255,0.04) inset, 0 12px 32px rgba(0,0,0,0.20)',
      }}>
        {/* Subtle decorative glow */}
        <div style={{
          position:'absolute', top:'-50%', right:'-10%', width:'400px', height:'400px',
          background: status?._offline
            ? 'radial-gradient(circle, rgba(239,68,68,0.10) 0%, transparent 70%)'
            : 'radial-gradient(circle, rgba(96,165,250,0.10) 0%, transparent 70%)',
          pointerEvents:'none', filter:'blur(40px)',
        }}/>

        <div style={{ display:'flex', alignItems:'center', gap:'16px',
          flexWrap:'wrap', position:'relative' }}>
          <div style={{ width:'48px', height:'48px', borderRadius:'14px',
            background: status?._offline
              ? 'linear-gradient(135deg, #1F2937, #0F172A)'
              : status?.running
                ? 'linear-gradient(135deg, #10B981, #059669)'
                : 'linear-gradient(135deg, #475569, #334155)',
            display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:'20px', fontWeight:800, color:'#fff',
            boxShadow: status?.running && !status?._offline
              ? '0 6px 16px rgba(16,185,129,0.35), 0 0 0 1px rgba(16,185,129,0.20)'
              : '0 4px 10px rgba(0,0,0,0.30)',
            animation: status?.running && !status?._offline ? 'pulse 2s ease-in-out infinite' : 'none',
          }}>
            {status?._offline ? '✕' : status?.running ? '●' : '○'}
          </div>
          <div style={{ flex:1, minWidth:'280px' }}>
            <div style={{ fontSize:'14px', fontWeight:700, color:'#F1F5F9',
              marginBottom:'4px', letterSpacing:'-0.01em' }}>
              {status?._offline ? '.NET API offline' :
                status?.running ? 'Watcher running' : 'Watcher disabled'}
            </div>
            <div style={{ fontSize:'11px', color:'#64748B', wordBreak:'break-all',
              fontFamily:'ui-monospace, "SF Mono", Menlo, monospace' }}>
              {status?.folder || 'bodycam_dotnet/WatchFolder/Inbox/'}
            </div>
          </div>
          <div style={{ display:'flex', gap:'8px', flexWrap:'wrap' }}>
            <KPI label="Total"     value={counts.total ?? 0}     color="#94A3B8"/>
            <KPI label="In Queue"  value={counts.queued ?? 0}    color="#94A3B8"/>
            <KPI label="Analyzing" value={counts.analyzing ?? 0} color="#60A5FA"/>
            <KPI label="Done"      value={counts.done ?? 0}      color="#34D399"/>
            <KPI label="Errors"    value={counts.error ?? 0}     color="#F87171"/>
          </div>
          <button onClick={rescan} disabled={busy}
            onMouseEnter={e => !busy && (e.currentTarget.style.transform = 'translateY(-1px)')}
            onMouseLeave={e => !busy && (e.currentTarget.style.transform = 'translateY(0)')}
            style={{ padding:'11px 18px', borderRadius:'12px', fontSize:'12px',
              fontWeight:700, color:'#fff', letterSpacing:'0.02em',
              background: busy
                ? 'linear-gradient(135deg, #1F2937, #0F172A)'
                : 'linear-gradient(135deg, #3B82F6 0%, #6366F1 50%, #8B5CF6 100%)',
              border:'none', cursor: busy ? 'not-allowed' : 'pointer',
              display:'flex', alignItems:'center', gap:'8px',
              boxShadow: busy ? 'none' : '0 6px 16px rgba(99,102,241,0.30)',
              transition:'all .2s' }}>
            {busy ? <Spinner size={12} color="#fff"/> : '↻'}
            Rescan now
          </button>
        </div>
        {status?.last_scan ? (
          <div style={{ marginTop:'14px', paddingTop:'12px',
            borderTop:'1px solid rgba(51,65,85,0.30)',
            fontSize:'10px', color:'#64748B',
            display:'flex', gap:'18px', flexWrap:'wrap',
            position:'relative' }}>
            <span>⏱ Last scan: <strong style={{ color:'#94A3B8' }}>{formatAgo(status.last_scan)}</strong></span>
            <span>🔄 Interval: every <strong style={{ color:'#94A3B8' }}>{status.scan_every || 5}s</strong></span>
            <span>👮 Default officer: <strong style={{ color:'#94A3B8' }}>{status.default_officer_id || 'EO000'}</strong></span>
            {status.done_folder && <span style={{ wordBreak:'break-all' }}>📁 Done: <strong style={{ color:'#94A3B8' }}>{status.done_folder}</strong></span>}
          </div>
        ) : null}
      </div>

      {/* Severity breakdown — premium tile design with icons */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:'12px',
        marginBottom:'18px' }}>
        {[
          { sev:'CRITICAL', count: sevCounts.CRITICAL || 0, icon:'⚠', label:'Critical' },
          { sev:'WARNING',  count: sevCounts.WARNING  || 0, icon:'⚡', label:'Warning'  },
          { sev:'NORMAL',   count: sevCounts.NORMAL   || 0, icon:'✓',  label:'Normal'   },
          { sev:'PENDING',  count: sevCounts.PENDING  || 0, icon:'⏱',  label:'Pending'  },
        ].map(s => {
          const cfg = SEV[s.sev] || SEV.NORMAL
          const isPending = s.sev === 'PENDING'
          return (
            <div key={s.sev} style={{
              position:'relative', overflow:'hidden',
              background: isPending
                ? 'linear-gradient(180deg, #111827 0%, #0F172A 100%)'
                : `linear-gradient(180deg, ${cfg.bg} 0%, rgba(15,23,42,0.4) 100%)`,
              border: isPending ? '1px solid rgba(51,65,85,0.40)' : `1px solid ${cfg.border}`,
              borderRadius:'16px', padding:'18px 20px',
              boxShadow:'0 1px 0 rgba(255,255,255,0.04) inset, 0 4px 12px rgba(0,0,0,0.15)',
              transition:'all .25s',
            }}
            onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 1px 0 rgba(255,255,255,0.04) inset, 0 12px 24px rgba(0,0,0,0.25)'; }}
            onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)';     e.currentTarget.style.boxShadow = '0 1px 0 rgba(255,255,255,0.04) inset, 0 4px 12px rgba(0,0,0,0.15)'; }}>
              {/* Decorative glow */}
              {!isPending && (
                <div style={{
                  position:'absolute', top:'-30px', right:'-30px',
                  width:'120px', height:'120px',
                  background:`radial-gradient(circle, ${cfg.bg} 0%, transparent 70%)`,
                  pointerEvents:'none', filter:'blur(20px)',
                }}/>
              )}
              <div style={{ display:'flex', alignItems:'center',
                justifyContent:'space-between', marginBottom:'10px',
                position:'relative' }}>
                <div style={{ fontSize:'10px',
                  color: isPending ? '#64748B' : cfg.text, opacity: isPending ? 1 : 0.85,
                  textTransform:'uppercase', fontWeight:800, letterSpacing:'0.10em' }}>
                  {s.sev}
                </div>
                <div style={{ fontSize:'14px',
                  color: isPending ? '#475569' : cfg.text, opacity:0.6 }}>
                  {s.icon}
                </div>
              </div>
              <div style={{ fontSize:'32px', fontWeight:900,
                color: isPending ? '#94A3B8' : cfg.text,
                position:'relative', lineHeight:1, letterSpacing:'-0.025em' }}>
                {s.count}
              </div>
            </div>
          )
        })}
      </div>

      {/* Search + Sort row */}
      <div style={{ display:'flex', gap:'10px', marginBottom:'12px',
        flexWrap:'wrap', alignItems:'center' }}>
        {/* Search input */}
        <div style={{ flex:1, minWidth:'240px', position:'relative' }}>
          <span style={{
            position:'absolute', left:'12px', top:'50%',
            transform:'translateY(-50%)', fontSize:'14px',
            color:'#64748B', pointerEvents:'none',
          }}>🔍</span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by filename or officer ID…"
            style={{
              width:'100%', padding:'10px 12px 10px 36px',
              borderRadius:'12px', fontSize:'12px',
              background:'rgba(11,15,26,0.60)',
              border:'1px solid rgba(51,65,85,0.40)',
              color:'#F1F5F9', outline:'none',
              transition:'all .2s',
            }}
            onFocus={e => { e.currentTarget.style.borderColor = 'rgba(96,165,250,0.50)'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(96,165,250,0.15)' }}
            onBlur={e => { e.currentTarget.style.borderColor = 'rgba(51,65,85,0.40)'; e.currentTarget.style.boxShadow = 'none' }}
          />
          {search && (
            <button onClick={() => setSearch('')}
              style={{
                position:'absolute', right:'8px', top:'50%',
                transform:'translateY(-50%)',
                background:'rgba(51,65,85,0.40)', border:'none',
                color:'#94A3B8', cursor:'pointer',
                width:'22px', height:'22px', borderRadius:'6px',
                fontSize:'11px', display:'flex',
                alignItems:'center', justifyContent:'center',
              }}>✕</button>
          )}
        </div>

        {/* Sort dropdown */}
        <div style={{ display:'flex', alignItems:'center', gap:'6px' }}>
          <span style={{ fontSize:'9px', color:'#475569', fontWeight:700,
            textTransform:'uppercase', letterSpacing:'0.10em' }}>
            Sort
          </span>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            style={{
              padding:'10px 32px 10px 12px',
              borderRadius:'10px', fontSize:'11px', fontWeight:700,
              background:'rgba(11,15,26,0.60)',
              border:'1px solid rgba(51,65,85,0.40)',
              color:'#CBD5E1', cursor:'pointer', outline:'none',
              appearance:'none', WebkitAppearance:'none',
              backgroundImage:`url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%2394A3B8' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'></polyline></svg>")`,
              backgroundRepeat:'no-repeat', backgroundPosition:'right 10px center',
              backgroundSize:'10px',
            }}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="score">Score (high → low)</option>
            <option value="severity">Severity (CRITICAL first)</option>
          </select>
        </div>
      </div>

      {/* Filter pills row — with live counts */}
      <div style={{ display:'flex', gap:'8px', marginBottom:'18px', flexWrap:'wrap',
        alignItems:'center' }}>
        <span style={{ fontSize:'9px', color:'#475569', fontWeight:700,
          textTransform:'uppercase', letterSpacing:'0.10em', marginRight:'4px' }}>
          Status
        </span>
        {['ALL', 'analyzing', 'done', 'error'].map(f => (
          <FilterPill key={f}
            label={f.toUpperCase()}
            count={f === 'ALL' ? items.length : (statusCounts[f] || 0)}
            active={filter === f}
            onClick={() => setFilter(f)}/>
        ))}
        <span style={{ width:'1px', height:'22px',
          background:'linear-gradient(180deg, transparent, #334155, transparent)',
          margin:'0 8px' }}/>
        <span style={{ fontSize:'9px', color:'#475569', fontWeight:700,
          textTransform:'uppercase', letterSpacing:'0.10em', marginRight:'4px' }}>
          Severity
        </span>
        {['ALL', 'CRITICAL', 'WARNING', 'NORMAL'].map(f => (
          <FilterPill key={f}
            label={f}
            count={f === 'ALL' ? items.length : (sevFilterCounts[f] || 0)}
            active={sevFilter === f}
            onClick={() => setSevFilter(f)}/>
        ))}
        {/* Active filter indicator */}
        {(filter !== 'ALL' || sevFilter !== 'ALL' || search) && (
          <button
            onClick={() => { setFilter('ALL'); setSevFilter('ALL'); setSearch('') }}
            style={{
              marginLeft:'8px', padding:'7px 12px', borderRadius:'8px',
              fontSize:'10px', fontWeight:700, letterSpacing:'0.04em',
              background:'rgba(239,68,68,0.10)',
              border:'1px solid rgba(239,68,68,0.30)',
              color:'#F87171', cursor:'pointer', transition:'all .15s',
              display:'flex', alignItems:'center', gap:'4px',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(239,68,68,0.18)'}
            onMouseLeave={e => e.currentTarget.style.background = 'rgba(239,68,68,0.10)'}>
            <span>✕</span> CLEAR FILTERS
          </button>
        )}
        {/* Result count */}
        <span style={{ marginLeft:'auto', fontSize:'10px', color:'#64748B',
          fontWeight:600 }}>
          Showing <strong style={{ color:'#94A3B8' }}>{visible.length}</strong> of {items.length}
        </span>
      </div>

      {/* Cards — empty state more inviting + grid more breathable + date groups */}
      {visible.length === 0 ? (
        <div style={{ ...CARD, textAlign:'center', padding:'72px 30px',
          background:'linear-gradient(180deg, rgba(17,24,39,0.6) 0%, rgba(15,23,42,0.4) 100%)',
          border:'1px dashed rgba(51,65,85,0.50)' }}>
          <div style={{ fontSize:'44px', marginBottom:'18px',
            opacity:0.4, filter:'grayscale(0.3)' }}>
            {items.length === 0 ? '📂' : '🔍'}
          </div>
          <div style={{ fontSize:'15px', fontWeight:700, color:'#CBD5E1',
            marginBottom:'8px', letterSpacing:'-0.01em' }}>
            {items.length === 0 ? 'No recordings in the database yet'
              : search ? 'No videos match your search'
              : 'No videos match the selected filters'}
          </div>
          <div style={{ fontSize:'12px', color:'#64748B', lineHeight:1.8,
            maxWidth:'480px', margin:'0 auto' }}>
            {items.length === 0 ? (
              <>Drop a video file into<br/>
              <code style={{
                display:'inline-block', marginTop:'8px', padding:'6px 14px',
                background:'rgba(96,165,250,0.10)', color:'#60A5FA',
                border:'1px solid rgba(96,165,250,0.25)', borderRadius:'8px',
                fontFamily:'ui-monospace, "SF Mono", Menlo, monospace',
                fontSize:'11px', wordBreak:'break-all',
              }}>
                {status?.folder || 'bodycam_dotnet/WatchFolder/Inbox/'}
              </code><br/><br/>
              and it will be analyzed automatically within seconds.</>
            ) : search
                ? <>Try a different keyword or <button onClick={() => setSearch('')} style={{ background:'transparent', border:'none', color:'#60A5FA', fontWeight:700, cursor:'pointer', textDecoration:'underline' }}>clear the search</button>.</>
                : 'Try clearing the status / severity filters above.'}
          </div>
        </div>
      ) : grouped ? (
        // Grouped view (newest/oldest sorting) — with date headers
        <>
          {['Today', 'Yesterday', 'This Week', 'Older'].map(g => {
            const groupItems = grouped[g]
            if (!groupItems || groupItems.length === 0) return null
            return (
              <div key={g} style={{ marginBottom:'24px' }}>
                <div style={{ display:'flex', alignItems:'center', gap:'10px',
                  marginBottom:'12px' }}>
                  <span style={{
                    fontSize:'11px', fontWeight:800, color:'#94A3B8',
                    letterSpacing:'0.10em', textTransform:'uppercase',
                  }}>
                    {g}
                  </span>
                  <span style={{
                    padding:'2px 9px', borderRadius:'10px',
                    background:'rgba(51,65,85,0.40)', color:'#94A3B8',
                    fontSize:'10px', fontWeight:700,
                  }}>
                    {groupItems.length}
                  </span>
                  <span style={{ flex:1, height:'1px',
                    background:'linear-gradient(90deg, rgba(51,65,85,0.40), transparent)' }}/>
                </div>
                <div style={{ display:'grid',
                  gridTemplateColumns:'repeat(auto-fill, minmax(380px, 1fr))', gap:'16px' }}>
                  {groupItems.map(item => (
                    <VideoCard key={item.file_id} item={item}
                      onOpen={() => openDetails(item)}
                      onRemove={(e) => remove(item, e)}/>
                  ))}
                </div>
              </div>
            )
          })}
        </>
      ) : (
        // Flat view (sorted by score/severity — no date grouping)
        <div style={{ display:'grid',
          gridTemplateColumns:'repeat(auto-fill, minmax(380px, 1fr))', gap:'16px' }}>
          {visible.map(item => (
            <VideoCard key={item.file_id} item={item}
              onOpen={() => openDetails(item)}
              onRemove={(e) => remove(item, e)}/>
          ))}
        </div>
      )}

      {/* Rich Gemini + acoustic + visual breakdown */}
      <IncidentDetailModal
        recordingId={openId}
        onClose={closeDetails}/>

      {/* Toast — fired when user clicks an in-flight ANALYZING / ERROR row */}
      {openToast && (
        <div style={{ position:'fixed', bottom:'24px', right:'24px',
          background:'rgba(15,23,42,0.95)', color:'#F1F5F9',
          border:'1px solid rgba(245,158,11,0.40)',
          borderLeft:'3px solid #F59E0B',
          padding:'12px 18px', borderRadius:'12px',
          fontSize:'12px', maxWidth:'360px', zIndex:1100,
          boxShadow:'0 12px 32px rgba(0,0,0,0.45)',
          animation:'fadeIn .2s ease-out' }}>
          <div style={{ fontSize:'10px', color:'#F59E0B', fontWeight:800,
            letterSpacing:'0.10em', textTransform:'uppercase',
            marginBottom:'4px' }}>
            {openToast.filename}
          </div>
          <div style={{ color:'#CBD5E1', lineHeight:1.5 }}>
            {openToast.message}
          </div>
        </div>
      )}
    </div>
  )
}


// ── Sub-components ────────────────────────────────────────────────────

function KPI({ label, value, color }) {
  return (
    <div style={{
      background:'linear-gradient(180deg, rgba(15,23,42,0.7) 0%, rgba(15,23,42,0.4) 100%)',
      borderRadius:'12px', padding:'10px 16px',
      border:'1px solid rgba(51,65,85,0.40)', minWidth:'80px',
      textAlign:'center',
      boxShadow:'0 1px 0 rgba(255,255,255,0.04) inset',
      transition:'all .2s',
    }}
    onMouseEnter={e => e.currentTarget.style.borderColor = `${color}55`}
    onMouseLeave={e => e.currentTarget.style.borderColor = 'rgba(51,65,85,0.40)'}>
      <div style={{ fontSize:'9px', color:'#64748B', fontWeight:700,
        textTransform:'uppercase', letterSpacing:'0.10em', marginBottom:'4px' }}>
        {label}
      </div>
      <div style={{ fontSize:'20px', fontWeight:800, color,
        letterSpacing:'-0.02em', lineHeight:1 }}>{value}</div>
    </div>
  )
}

// Tone label as a coloured chip — refined glassmorphism style
const TONE_COLOR = {
  NORMAL:     { fg:'#34D399', bg:'rgba(16,185,129,0.12)',  border:'rgba(16,185,129,0.35)' },
  HARSH:      { fg:'#FBBF24', bg:'rgba(245,158,11,0.14)',  border:'rgba(245,158,11,0.35)' },
  ANGRY:      { fg:'#F87171', bg:'rgba(239,68,68,0.14)',   border:'rgba(239,68,68,0.35)'  },
  BRIBE_TONE: { fg:'#A78BFA', bg:'rgba(139,92,246,0.14)',  border:'rgba(139,92,246,0.35)' },
}

// Muted style — used when the SVM heard ANGRY/HARSH/BRIBE but the overall
// severity stayed NORMAL (acoustic-only, no abusive language). Avoids the
// visual contradiction of a red ANGRY chip on a green NORMAL card.
const TONE_MUTED = { fg:'#94A3B8', bg:'rgba(148,163,184,0.10)',
  border:'rgba(148,163,184,0.30)' }

function ToneChip({ tone, severity }) {
  const acousticOnly =
    /ANGRY|HARSH|BRIBE/.test(tone || '') && severity === 'NORMAL'
  const cfg = acousticOnly
    ? TONE_MUTED
    : (TONE_COLOR[tone] || TONE_COLOR.NORMAL)
  return (
    <span title={acousticOnly
        ? `Voice classified ${tone} but no abusive language → severity NORMAL`
        : undefined}
      style={{
        padding:'3px 10px', borderRadius:'6px', fontWeight:700,
        letterSpacing:'0.06em', fontSize:'10px',
        color: cfg.fg, background: cfg.bg,
        border:`1px solid ${cfg.border}`,
        boxShadow:`0 0 8px ${cfg.bg}`,
        opacity: acousticOnly ? 0.85 : 1,
      }}>
      {tone.replace('_TONE', '')}
      {acousticOnly && (
        <span style={{ marginLeft:'5px', fontSize:'8px', opacity:0.75 }}>
          · acoustic
        </span>
      )}
    </span>
  )
}

function FilterPill({ label, active, onClick, count }) {
  return (
    <button onClick={onClick}
      onMouseEnter={e => !active && (e.currentTarget.style.background = 'rgba(51,65,85,0.30)')}
      onMouseLeave={e => !active && (e.currentTarget.style.background = 'rgba(11,15,26,0.60)')}
      style={{
        padding:'8px 14px', borderRadius:'10px', fontSize:'11px', fontWeight:700,
        letterSpacing:'0.06em',
        background: active
          ? 'linear-gradient(135deg, rgba(96,165,250,0.20) 0%, rgba(99,102,241,0.20) 100%)'
          : 'rgba(11,15,26,0.60)',
        border: active
          ? '1px solid rgba(96,165,250,0.50)'
          : '1px solid rgba(51,65,85,0.40)',
        color: active ? '#60A5FA' : '#94A3B8',
        cursor:'pointer', transition:'all .2s',
        boxShadow: active ? '0 0 16px rgba(96,165,250,0.20)' : 'none',
        display:'inline-flex', alignItems:'center', gap:'6px',
    }}>
      {label}
      {typeof count === 'number' && (
        <span style={{
          padding:'1px 7px', borderRadius:'10px',
          background: active ? 'rgba(96,165,250,0.30)' : 'rgba(51,65,85,0.50)',
          color: active ? '#DBEAFE' : '#94A3B8',
          fontSize:'10px', fontWeight:800,
          minWidth:'20px', textAlign:'center',
        }}>
          {count}
        </span>
      )}
    </button>
  )
}

function VideoCard({ item, onOpen, onRemove }) {
  const stat = STATUS_COLOR[item.status] || STATUS_COLOR.queued
  const sev = item.severity
  const sevCfg = sev ? (SEV[sev] || SEV.NORMAL) : null
  const score = item.total_score ?? 0
  const isAnalyzing = item.status === 'analyzing'
  const isPulsing = sev === 'CRITICAL'
  const violationCount = item.violations_count ?? 0

  // Severity-driven gradient backgrounds for visual hierarchy
  const cardBg = sev === 'CRITICAL'
    ? 'linear-gradient(180deg, rgba(239,68,68,0.06) 0%, rgba(17,24,39,0.95) 60%)'
    : sev === 'WARNING'
      ? 'linear-gradient(180deg, rgba(245,158,11,0.05) 0%, rgba(17,24,39,0.95) 60%)'
      : 'linear-gradient(180deg, #111827 0%, #0F172A 100%)'

  const cardBorder = sev === 'CRITICAL' ? '1px solid rgba(239,68,68,0.35)'
                  : sev === 'WARNING'  ? '1px solid rgba(245,158,11,0.25)'
                  : '1px solid rgba(51,65,85,0.40)'

  return (
    <div onClick={onOpen}
      className="va-card-anim"
      style={{
        position:'relative', overflow:'hidden',
        background: cardBg,
        border: cardBorder,
        borderRadius:'16px', padding:'18px', cursor:'pointer',
        transition:'all .25s cubic-bezier(0.4, 0, 0.2, 1)',
        boxShadow:'0 1px 0 rgba(255,255,255,0.04) inset, 0 4px 16px rgba(0,0,0,0.20)',
        animation: isPulsing ? 'criticalPulse 3s infinite' : undefined,
      }}
      onMouseEnter={e => {
        e.currentTarget.style.transform = 'translateY(-3px)'
        e.currentTarget.style.boxShadow = '0 1px 0 rgba(255,255,255,0.06) inset, 0 16px 32px rgba(0,0,0,0.30)'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = 'translateY(0)'
        e.currentTarget.style.boxShadow = '0 1px 0 rgba(255,255,255,0.04) inset, 0 4px 16px rgba(0,0,0,0.20)'
      }}>

      {/* Subtle severity glow in corner */}
      {sev && sev !== 'NORMAL' && (
        <div style={{
          position:'absolute', top:'-40px', right:'-40px', width:'160px', height:'160px',
          background: `radial-gradient(circle, ${sevCfg?.bg} 0%, transparent 70%)`,
          pointerEvents:'none', filter:'blur(30px)',
        }}/>
      )}

      {/* Top row: status + severity + delete */}
      <div style={{ display:'flex', justifyContent:'space-between',
        alignItems:'flex-start', gap:'8px', marginBottom:'14px',
        position:'relative' }}>
        <span style={{
          padding:'4px 12px', borderRadius:'8px', fontSize:'9px',
          fontWeight:800, letterSpacing:'0.10em',
          color: stat.fg, background: stat.bg, border: `1px solid ${stat.border}`,
          display:'inline-flex', alignItems:'center', gap:'6px',
          boxShadow: `0 0 12px ${stat.glow || stat.bg}`,
        }}>
          {isAnalyzing && <Spinner size={9} color={stat.fg}/>}
          {!isAnalyzing && <span style={{ fontSize:'10px' }}>{stat.icon}</span>}
          {stat.label}
        </span>
        <div style={{ display:'flex', gap:'8px', alignItems:'center' }}>
          {sevCfg && <SeverityBadge severity={sev}/>}
          <button onClick={onRemove}
            title={item.recording_id ? 'Delete from database' : 'Remove from list'}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(239,68,68,0.10)'; e.currentTarget.style.color = '#F87171' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = '#475569' }}
            style={{
              background:'transparent', border:'1px solid rgba(51,65,85,0.40)',
              color:'#475569', width:'24px', height:'24px',
              fontSize:'12px', cursor:'pointer', padding:0,
              display:'flex', alignItems:'center', justifyContent:'center',
              borderRadius:'6px', transition:'all .15s',
            }}>
            ✕
          </button>
        </div>
      </div>

      {/* Filename — bold and prominent */}
      <div style={{ fontSize:'14px', fontWeight:700, color:'#F1F5F9',
        marginBottom:'6px', wordBreak:'break-all', lineHeight:1.4,
        letterSpacing:'-0.01em', position:'relative' }}>
        {item.filename}
      </div>
      <div style={{ fontSize:'10px', color:'#64748B', marginBottom:'14px',
        display:'flex', alignItems:'center', gap:'6px', position:'relative' }}>
        <span style={{
          padding:'2px 8px', borderRadius:'4px', fontSize:'9px', fontWeight:700,
          background:'rgba(51,65,85,0.30)', color:'#94A3B8',
          letterSpacing:'0.05em',
        }}>
          {item.media_type === 'video' ? '🎬 VIDEO' : '🎙 AUDIO'}
        </span>
        {item.size_bytes && <span>{formatBytes(item.size_bytes)}</span>}
        {item.duration_sec ? <span>· {item.duration_sec.toFixed(1)}s</span> : null}
        <span style={{ marginLeft:'auto' }}>{formatAgo(item.finished_at || item.started_at || item.queued_at)}</span>
      </div>

      {/* Body — analyzing / queued / error / done */}
      {item.status === 'queued' && (
        <div style={{ fontSize:'11px', color:'#64748B', fontStyle:'italic',
          padding:'10px 12px', background:'rgba(51,65,85,0.20)',
          borderRadius:'10px', textAlign:'center' }}>
          ⏱  Waiting for the worker thread…
        </div>
      )}

      {isAnalyzing && (
        <div style={{ display:'flex', alignItems:'center', gap:'12px',
          background:'linear-gradient(135deg, rgba(96,165,250,0.10) 0%, rgba(99,102,241,0.05) 100%)',
          borderRadius:'12px', padding:'14px',
          border:'1px solid rgba(96,165,250,0.25)',
          boxShadow:'0 0 16px rgba(96,165,250,0.15)' }}>
          <Spinner size={20} color="#60A5FA"/>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:'11px', color:'#60A5FA', fontWeight:700,
              marginBottom:'2px', letterSpacing:'0.02em' }}>
              Running analysis pipeline
            </div>
            <div style={{ fontSize:'10px', color:'#64748B', lineHeight:1.5 }}>
              ffmpeg · Gemini · voiceprint · transcription · scoring
            </div>
          </div>
        </div>
      )}

      {item.status === 'error' && (
        <div style={{ fontSize:'11px', color:'#F87171', lineHeight:1.6,
          background:'linear-gradient(135deg, rgba(239,68,68,0.10) 0%, rgba(239,68,68,0.04) 100%)',
          borderRadius:'10px', padding:'12px 14px',
          border:'1px solid rgba(239,68,68,0.30)' }}>
          <div style={{ fontSize:'9px', fontWeight:800, letterSpacing:'0.10em',
            color:'#EF4444', marginBottom:'4px' }}>
            ⚠ PIPELINE ERROR
          </div>
          {item.error || 'Pipeline error'}
        </div>
      )}

      {item.status === 'done' && (
        <>
          <div style={{ display:'flex', gap:'16px', alignItems:'center',
            marginBottom:'14px', position:'relative' }}>
            <ScoreRing score={score} severity={sev || 'NORMAL'} size={76}/>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:'9px', color:'#64748B', fontWeight:800,
                textTransform:'uppercase', letterSpacing:'0.10em', marginBottom:'5px' }}>
                Officer
              </div>
              <div style={{ fontSize:'13px', fontWeight:700, color:'#F1F5F9',
                letterSpacing:'-0.01em', marginBottom:'2px',
                whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                {item.officer_name || item.officer_id || 'Unknown'}
              </div>
              {item.officer_badge && (
                <div style={{ fontSize:'10px', color:'#64748B',
                  fontFamily:'ui-monospace, "SF Mono", Menlo, monospace' }}>
                  {item.officer_badge}
                </div>
              )}
              <div style={{ marginTop:'8px', display:'flex', gap:'6px',
                alignItems:'center', flexWrap:'wrap' }}>
                <ToneChip tone={item.tone_label || 'NORMAL'}
                  severity={item.severity}/>
                <span style={{ fontSize:'10px', color:'#64748B', fontWeight:600 }}>
                  {violationCount} violation{violationCount === 1 ? '' : 's'}
                </span>
              </div>
            </div>
          </div>

          {violationCount > 0 && (
            <div style={{ marginBottom:'12px', position:'relative' }}>
              <div style={LABEL}>Violations detected</div>
              <span style={{
                display:'inline-flex', alignItems:'center', gap:'6px',
                fontSize:'10px', fontWeight:700,
                padding:'5px 12px', borderRadius:'8px',
                color:'#F87171',
                background:'linear-gradient(135deg, rgba(239,68,68,0.12) 0%, rgba(239,68,68,0.04) 100%)',
                border:'1px solid rgba(239,68,68,0.30)',
                boxShadow:'0 0 12px rgba(239,68,68,0.10)',
              }}>
                <span>⚠</span>
                {violationCount} flagged — open card for details
              </span>
            </div>
          )}

          <div style={{ marginTop:'14px', paddingTop:'12px',
            borderTop:'1px solid rgba(51,65,85,0.30)',
            textAlign:'center', fontSize:'11px',
            color:'#60A5FA', fontWeight:700, letterSpacing:'0.02em',
            position:'relative' }}>
            Click to view full assessment →
          </div>
        </>
      )}
    </div>
  )
}
