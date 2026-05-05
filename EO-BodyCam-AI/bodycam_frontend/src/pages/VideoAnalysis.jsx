import React, { useEffect, useRef, useState } from 'react'
import { ScoreRing, SeverityBadge, Spinner, SEV } from '../components/UI'
import { ResultPanel } from './Upload'
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
  background: '#111827', border: '1px solid #1F2937',
  borderRadius: '16px', padding: '18px', marginBottom: '14px',
}
const LABEL = {
  fontSize: '10px', color: '#64748B', textTransform: 'uppercase',
  letterSpacing: '0.08em', fontWeight: 700, marginBottom: '10px', display: 'block',
}

const STATUS_COLOR = {
  queued:    { fg: '#94A3B8', bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.30)', label: 'QUEUED' },
  analyzing: { fg: '#3B82F6', bg: 'rgba(59,130,246,0.12)',  border: 'rgba(59,130,246,0.35)',  label: 'ANALYZING' },
  done:      { fg: '#10B981', bg: 'rgba(16,185,129,0.10)',  border: 'rgba(16,185,129,0.30)',  label: 'DONE' },
  error:     { fg: '#EF4444', bg: 'rgba(239,68,68,0.10)',   border: 'rgba(239,68,68,0.30)',   label: 'ERROR' },
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
  const [openId,    setOpenId]    = useState(null)
  const [openData,  setOpenData]  = useState(null)

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

  const openDetails = async (item) => {
    setOpenId(item.file_id)
    setOpenData(null)
    if (!item.recording_id) {
      setOpenData({ error: item.error || 'No DB record yet — analysis still in progress.' })
      return
    }
    try {
      const r = await ApiService.dotnetRecording(item.recording_id)
      const detail = r.data
      const ar = detail?.analysisResult || {}

      // The Python pipeline stores its full snake_case JSON in RawJson;
      // ResultPanel was written against that shape, so we parse it back
      // out and feed it in directly. Falls back to a minimal object built
      // from the flat columns if RawJson is missing.
      let result = null
      if (ar.rawJson) {
        try { result = JSON.parse(ar.rawJson) } catch (_) { result = null }
      }
      if (!result) {
        result = {
          severity:           ar.severity,
          total_score:        ar.totalScore,
          tone_score:         ar.toneScore,
          keyword_score:      ar.kwScore,
          tone_label:         ar.toneLabel,
          transcript:         ar.transcriptUrdu,
          transcription_method: ar.transcriptionMethod,
          media_type:         detail.mediaType,
          violations:         detail.violations || [],
        }
      }
      setOpenData({
        filename: detail.filename,
        status:   'done',
        result,
      })
    } catch (_e) {
      setOpenData({ error: 'Could not fetch full result' })
    }
  }

  const closeDetails = () => { setOpenId(null); setOpenData(null) }

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
          Drop any video / audio file into the watch folder below — the .NET
          server detects it automatically, extracts audio, runs Gemini analysis,
          and persists the result to MSSQL. The list below is read straight from
          the DB and survives restarts.
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
              {status?._offline ? '.NET API offline' :
                status?.running ? 'Watcher running' : 'Watcher disabled'}
            </div>
            <div style={{ fontSize:'11px', color:'#64748B', wordBreak:'break-all' }}>
              {status?.folder || 'bodycam_dotnet/WatchFolder/Inbox/'}
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
            <span>Interval: every {status.scan_every || 5}s</span>
            <span>Default officer: {status.default_officer_id || 'EO000'}</span>
            {status.done_folder && <span>Done folder: {status.done_folder}</span>}
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
        {['ALL', 'analyzing', 'done', 'error'].map(f => (
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
            {items.length === 0 ? 'No recordings in the database yet'
              : 'No videos match the selected filters'}
          </div>
          <div style={{ fontSize:'12px', color:'#475569', lineHeight:1.7 }}>
            {items.length === 0 ? (
              <>Drop a video file into <code style={{ color:'#3B82F6' }}>
                {status?.folder || 'bodycam_dotnet/WatchFolder/Inbox/'}
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
              onRemove={(e) => remove(item, e)}/>
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

// Tone label as a coloured chip so it's instantly readable next to the score.
const TONE_COLOR = {
  NORMAL:     { fg:'#10B981', bg:'rgba(16,185,129,0.10)',  border:'rgba(16,185,129,0.30)' },
  HARSH:      { fg:'#F59E0B', bg:'rgba(245,158,11,0.12)',  border:'rgba(245,158,11,0.30)' },
  ANGRY:      { fg:'#EF4444', bg:'rgba(239,68,68,0.12)',   border:'rgba(239,68,68,0.30)'  },
  BRIBE_TONE: { fg:'#8B5CF6', bg:'rgba(139,92,246,0.12)',  border:'rgba(139,92,246,0.30)' },
}

function ToneChip({ tone }) {
  const cfg = TONE_COLOR[tone] || TONE_COLOR.NORMAL
  return (
    <span style={{
      padding:'2px 8px', borderRadius:'5px', fontWeight:700, letterSpacing:'0.04em',
      color: cfg.fg, background: cfg.bg, border:`1px solid ${cfg.border}`,
    }}>
      {tone.replace('_TONE', '')}
    </span>
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
  const isAnalyzing = item.status === 'analyzing'
  const isPulsing = sev === 'CRITICAL'
  const violationCount = item.violations_count ?? 0

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

      {/* Top row: status + severity */}
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
          <button onClick={onRemove}
            title={item.recording_id ? 'Delete from database' : 'Remove from list'}
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
        {item.media_type === 'video' ? '🎬 Video' : '🎙 Audio'}
        {item.size_bytes ? ` · ${formatBytes(item.size_bytes)}` : ''}
        {item.duration_sec ? ` · ${item.duration_sec.toFixed(1)}s` : ''}
        {' · '}{formatAgo(item.finished_at || item.started_at || item.queued_at)}
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
            Running pipeline — ffmpeg · Gemini · voiceprint · transcription · scoring
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
              <div style={{ marginTop:'6px', display:'flex', gap:'8px',
                fontSize:'10px', color:'#64748B', flexWrap:'wrap' }}>
                <ToneChip tone={item.tone_label || 'NORMAL'}/>
                <span>{violationCount} violation{violationCount === 1 ? '' : 's'}</span>
              </div>
            </div>
          </div>

          {violationCount > 0 && (
            <div style={{ marginBottom:'10px' }}>
              <div style={LABEL}>Violations detected</div>
              <span style={{
                fontSize:'10px', fontWeight:600,
                padding:'3px 8px', borderRadius:'6px',
                color:'#EF4444', background:'rgba(239,68,68,0.10)',
                border:'1px solid rgba(239,68,68,0.25)',
              }}>
                {violationCount} flagged — open card for details
              </span>
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
