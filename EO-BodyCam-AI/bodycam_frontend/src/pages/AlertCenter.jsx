import React, { useState, useEffect, useMemo, useRef } from 'react'
import ApiService          from '../services/api'
import IncidentDetailModal from '../components/IncidentDetailModal'

/**
 * AlertCenter — the monitoring team's main workspace.
 *
 *   • Live feed of CRITICAL + WARNING incidents from MSSQL
 *   • Sound chime + browser notification when a new CRITICAL arrives
 *   • Status workflow (NEW / ACK / REVIEWED / FALSE_POSITIVE / CLOSED)
 *     tracked in localStorage — no DB changes, multi-team-member ready when
 *     we add the backend table in Phase 5
 *   • One-click acknowledge / mark-reviewed / false-positive
 *   • Filter by status, severity, time range, search by officer/filename
 *   • Auto-refresh every 15s
 *
 * Pure read of analysis results. Zero analysis logic. Zero scoring changes.
 */

const SEV = {
  CRITICAL: { color:'#EF4444', bg:'rgba(239,68,68,0.10)',  border:'rgba(239,68,68,0.30)',  glow:'0 0 24px rgba(239,68,68,0.20)' },
  WARNING:  { color:'#F59E0B', bg:'rgba(245,158,11,0.10)', border:'rgba(245,158,11,0.30)', glow:'0 0 24px rgba(245,158,11,0.15)' },
  NORMAL:   { color:'#10B981', bg:'rgba(16,185,129,0.10)', border:'rgba(16,185,129,0.30)', glow:'0 0 16px rgba(16,185,129,0.10)' },
}

const STATUS_META = {
  NEW:            { color:'#EF4444', icon:'!',  label:'NEW' },
  ACK:            { color:'#F59E0B', icon:'◐',  label:'ACKNOWLEDGED' },
  REVIEWED:       { color:'#3B82F6', icon:'✓',  label:'REVIEWED' },
  FALSE_POSITIVE: { color:'#64748B', icon:'✗',  label:'FALSE POSITIVE' },
  CLOSED:         { color:'#10B981', icon:'●',  label:'CLOSED' },
}

const STATUS_FLOW = ['NEW', 'ACK', 'REVIEWED', 'CLOSED']

// ── localStorage state persistence ─────────────────────────────────
// In Phase 5 we'll migrate this to MSSQL columns + audit log.
const LS_KEY = 'pera_alert_states_v1'

const loadStates = () => {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') }
  catch { return {} }
}
const saveStates = (s) => {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)) } catch {}
}

const fmtRel = (iso) => {
  const t = new Date(iso).getTime()
  const m = Math.round((Date.now() - t) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

export default function AlertCenter({ alerts: liveAlerts = [], markRead }) {
  const [items,      setItems]      = useState([])
  const [loading,    setLoading]    = useState(true)
  const [err,        setErr]        = useState(null)
  const [states,     setStates]     = useState(loadStates())
  const [openId,     setOpenId]     = useState(null)
  const [search,     setSearch]     = useState('')
  const [showStatus, setShowStatus] = useState('OPEN')   // OPEN | ALL | REVIEWED | CLOSED
  const [sevFilter,  setSevFilter]  = useState('ALL')     // ALL | CRITICAL | WARNING
  const [soundOn,    setSoundOn]    = useState(true)
  const [notifsOn,   setNotifsOn]   = useState(false)
  const [stats,      setStats]      = useState({ critical:0, warning:0, total:0 })

  // Track which IDs we've already announced so the chime doesn't fire on every refresh
  const seenIdsRef = useRef(new Set())

  // ── Load incidents from MSSQL (live) ───────────────────────────
  const load = async () => {
    try {
      const [r, s] = await Promise.all([
        ApiService.dotnetRecordings({ page:1, pageSize:200 }),
        ApiService.dotnetRecordingStats(),
      ])
      const list = (r.data?.items || [])
        .filter(i => i.severity === 'CRITICAL' || i.severity === 'WARNING')
      // Detect newly-arrived CRITICALs vs what we'd already seen
      const knownIds = seenIdsRef.current
      const isFirstLoad = knownIds.size === 0
      const newCriticals = isFirstLoad ? [] : list.filter(
        i => i.severity === 'CRITICAL' && !knownIds.has(i.id)
      )
      list.forEach(i => knownIds.add(i.id))
      setItems(list)
      setStats({
        critical: s.data?.critical || 0,
        warning:  s.data?.warning  || 0,
        total:    s.data?.totalRecordings || 0,
      })
      setErr(null)
      // Fire UI signals for new CRITICALs only after first load
      if (newCriticals.length > 0) onNewCriticals(newCriticals)
    } catch (e) {
      setErr('Cannot reach .NET API')
    } finally {
      setLoading(false)
    }
  }

  // ── Sound + browser notification on new CRITICAL ───────────────
  const audioCtxRef = useRef(null)
  const playChime = () => {
    if (!soundOn) return
    try {
      // Use Web Audio API for a clean two-tone alert chime (no asset needed).
      const ctx = audioCtxRef.current ||
        (audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)())
      const make = (freq, when, dur) => {
        const o = ctx.createOscillator()
        const g = ctx.createGain()
        o.connect(g); g.connect(ctx.destination)
        o.frequency.value = freq
        o.type = 'sine'
        g.gain.setValueAtTime(0,    ctx.currentTime + when)
        g.gain.linearRampToValueAtTime(0.20, ctx.currentTime + when + 0.02)
        g.gain.linearRampToValueAtTime(0,    ctx.currentTime + when + dur)
        o.start(ctx.currentTime + when)
        o.stop(ctx.currentTime + when + dur + 0.05)
      }
      make(880, 0,    0.18)   // higher note
      make(660, 0.22, 0.28)   // resolve lower
    } catch {}
  }
  const fireNotification = (rec) => {
    if (!notifsOn || Notification.permission !== 'granted') return
    try {
      const n = new Notification(`⚠ CRITICAL — ${rec.officerId}`, {
        body: `${rec.filename} · score ${rec.score}/100 · ${rec.violationCount} violations`,
        tag:  `pera-${rec.id}`,
      })
      n.onclick = () => { window.focus(); setOpenId(rec.id) }
      setTimeout(() => n.close(), 8000)
    } catch {}
  }

  const onNewCriticals = (list) => {
    playChime()
    list.slice(0, 3).forEach(fireNotification)
    // Flash the page title
    flashTitle(`(${list.length}) NEW CRITICAL`)
  }

  useEffect(() => {
    load()
    const id = setInterval(load, 15000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Page-title flasher ─────────────────────────────────────────
  const origTitleRef = useRef(document.title)
  useEffect(() => () => { document.title = origTitleRef.current }, [])
  const flashTitle = (msg) => {
    const orig = origTitleRef.current
    let on = true
    let count = 0
    const id = setInterval(() => {
      document.title = on ? msg : orig
      on = !on
      count++
      if (count >= 10) { clearInterval(id); document.title = orig }
    }, 500)
  }

  // ── Workflow actions ───────────────────────────────────────────
  const setItemStatus = (id, status, note) => {
    const next = { ...states }
    next[id] = {
      ...(next[id] || {}),
      status,
      [`${status.toLowerCase()}At`]: new Date().toISOString(),
      ...(note ? { note } : {}),
    }
    setStates(next)
    saveStates(next)
  }
  const getStatus = (id) => states[id]?.status || 'NEW'
  const getNote   = (id) => states[id]?.note || ''

  // ── PERMANENT delete (calls .NET DELETE /api/recordings/{id}) ────
  // This wipes the recording + its analysis_results + violations rows.
  // Two-step confirm so it can't happen by accident.  Audit log will be
  // added in Phase 5 — until then, deletes are not recoverable.
  const deleteRecording = async (inc) => {
    const ok = window.confirm(
      `⚠ PERMANENT DELETE\n\n` +
      `File: ${inc.filename}\n` +
      `Officer: ${inc.officerId}\n` +
      `Severity: ${inc.severity}\n` +
      `Score: ${inc.score}/100\n\n` +
      `This will remove the recording, its analysis, and all violations from MSSQL forever.\n` +
      `The original video in WatchFolder/Processed/ is kept.\n\n` +
      `Continue?`
    )
    if (!ok) return
    try {
      await ApiService.dotnetDeleteRecording(inc.id)
      // Remove from local view immediately + clear its localStorage state
      setItems(prev => prev.filter(x => x.id !== inc.id))
      const next = { ...states }
      delete next[inc.id]
      setStates(next)
      saveStates(next)
    } catch (e) {
      const reason = e?.response?.data?.error || e?.message || 'unknown error'
      alert(`Delete failed: ${reason}`)
    }
  }

  // ── Filtering ──────────────────────────────────────────────────
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter(i => {
      if (sevFilter !== 'ALL' && i.severity !== sevFilter) return false
      const status = getStatus(i.id)
      if (showStatus === 'OPEN'     && ['REVIEWED','CLOSED','FALSE_POSITIVE'].includes(status)) return false
      if (showStatus === 'REVIEWED' && status !== 'REVIEWED') return false
      if (showStatus === 'CLOSED'   && status !== 'CLOSED')   return false
      if (q && !`${i.filename} ${i.officerId} ${i.toneLabel}`.toLowerCase().includes(q)) return false
      return true
    })
  }, [items, search, showStatus, sevFilter, states])

  const counts = useMemo(() => {
    const c = { OPEN:0, REVIEWED:0, CLOSED:0, CRITICAL:0, WARNING:0 }
    items.forEach(i => {
      const s = getStatus(i.id)
      if (s === 'REVIEWED')        c.REVIEWED++
      else if (s === 'CLOSED')     c.CLOSED++
      else                          c.OPEN++
      if (i.severity === 'CRITICAL') c.CRITICAL++
      else if (i.severity === 'WARNING') c.WARNING++
    })
    return c
  }, [items, states])

  const newCriticalCount = useMemo(
    () => items.filter(i => i.severity === 'CRITICAL' && getStatus(i.id) === 'NEW').length,
    [items, states],
  )

  return (
    <div style={{ padding:'28px 32px', color:'#F1F5F9', minHeight:'100vh' }}>

      {/* ── Sticky banner when there are unacknowledged criticals ── */}
      {newCriticalCount > 0 && showStatus === 'OPEN' && (
        <div style={{ position:'sticky', top:0, zIndex:50,
          marginBottom:'18px', padding:'12px 18px',
          background:'linear-gradient(90deg, rgba(239,68,68,0.18), rgba(220,38,38,0.10))',
          border:'1px solid rgba(239,68,68,0.45)',
          borderRadius:'12px',
          boxShadow:'0 0 32px rgba(239,68,68,0.25)',
          display:'flex', alignItems:'center', gap:'14px',
          animation:'pulseAlert 2s ease-in-out infinite' }}>
          <span style={{ fontSize:'24px' }}>🚨</span>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:'13px', fontWeight:900, color:'#FCA5A5',
              letterSpacing:'0.05em' }}>
              {newCriticalCount} UNACKNOWLEDGED CRITICAL{newCriticalCount === 1 ? '' : 'S'}
            </div>
            <div style={{ fontSize:'11px', color:'#FECACA' }}>
              Action required by the monitoring team
            </div>
          </div>
        </div>
      )}

      {/* ── Header ─────────────────────────────────────────────── */}
      <div style={{ display:'flex', alignItems:'flex-end',
        justifyContent:'space-between', marginBottom:'24px', gap:'18px',
        flexWrap:'wrap' }}>
        <div>
          <div style={{ display:'flex', alignItems:'center', gap:'12px',
            marginBottom:'6px' }}>
            <div style={{ width:42, height:42, borderRadius:'12px',
              background:'linear-gradient(135deg, #EF4444, #DC2626)',
              display:'flex', alignItems:'center', justifyContent:'center',
              fontSize:'18px', color:'#fff', fontWeight:900,
              boxShadow:'0 8px 20px rgba(239,68,68,0.35)' }}>!</div>
            <div>
              <h1 style={{ fontSize:'26px', fontWeight:800, margin:0,
                letterSpacing:'-0.02em', color:'#F1F5F9' }}>
                Alert Center
              </h1>
              <div style={{ fontSize:'12px', color:'#64748B', marginTop:'2px' }}>
                Live incident feed for the monitoring team · auto-refresh 15s
              </div>
            </div>
          </div>
        </div>

        {/* Toolbar */}
        <div style={{ display:'flex', alignItems:'center', gap:'8px',
          flexWrap:'wrap' }}>
          <Toggle label="Sound"     on={soundOn}  onChange={setSoundOn}/>
          <Toggle label="Notifs"    on={notifsOn} onChange={async (v) => {
            if (v && Notification.permission === 'default') {
              const p = await Notification.requestPermission()
              setNotifsOn(p === 'granted')
            } else {
              setNotifsOn(v)
            }
          }}/>
          <button onClick={load} style={refreshBtnStyle}>↻ Refresh</button>
        </div>
      </div>

      {/* ── KPI tiles ──────────────────────────────────────────── */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)',
        gap:'12px', marginBottom:'18px' }}>
        <KpiTile label="Open"          val={counts.OPEN}     color="#EF4444"/>
        <KpiTile label="Critical"      val={counts.CRITICAL} color="#DC2626"/>
        <KpiTile label="Warning"       val={counts.WARNING}  color="#F59E0B"/>
        <KpiTile label="Reviewed (24h)" val={counts.REVIEWED} color="#10B981"/>
      </div>

      {/* ── Filter row ────────────────────────────────────────── */}
      <div style={{ display:'flex', gap:'8px', marginBottom:'16px',
        flexWrap:'wrap', alignItems:'center' }}>
        <FilterGroup label="Status">
          <Pill on={showStatus==='OPEN'}     onClick={() => setShowStatus('OPEN')}     >Open · {counts.OPEN}</Pill>
          <Pill on={showStatus==='REVIEWED'} onClick={() => setShowStatus('REVIEWED')} >Reviewed · {counts.REVIEWED}</Pill>
          <Pill on={showStatus==='CLOSED'}   onClick={() => setShowStatus('CLOSED')}   >Closed · {counts.CLOSED}</Pill>
          <Pill on={showStatus==='ALL'}      onClick={() => setShowStatus('ALL')}      >All · {items.length}</Pill>
        </FilterGroup>
        <FilterGroup label="Severity">
          <Pill on={sevFilter==='ALL'}      onClick={() => setSevFilter('ALL')}     >Both</Pill>
          <Pill on={sevFilter==='CRITICAL'} onClick={() => setSevFilter('CRITICAL')} color="#EF4444">Critical · {counts.CRITICAL}</Pill>
          <Pill on={sevFilter==='WARNING'}  onClick={() => setSevFilter('WARNING')}  color="#F59E0B">Warning · {counts.WARNING}</Pill>
        </FilterGroup>
        <input placeholder="Search filename, officer, tone…"
          value={search} onChange={e => setSearch(e.target.value)}
          style={{ marginLeft:'auto', minWidth:'260px', padding:'9px 14px',
            fontSize:'12px', background:'rgba(255,255,255,0.03)', color:'#F1F5F9',
            border:'1px solid #1F2937', borderRadius:'10px', outline:'none' }}/>
      </div>

      {/* ── Feed ────────────────────────────────────────────────── */}
      {loading ? (
        <Empty>Loading from MSSQL…</Empty>
      ) : err ? (
        <Empty error>Cannot reach .NET API</Empty>
      ) : visible.length === 0 ? (
        <Empty>
          {showStatus === 'OPEN' ? '🎉  No open alerts — the team is caught up.' : 'No incidents match your filters.'}
        </Empty>
      ) : (
        visible.map(inc => (
          <AlertCard key={inc.id} inc={inc}
            status={getStatus(inc.id)}
            note={getNote(inc.id)}
            onOpen={() => setOpenId(inc.id)}
            onAck={() => setItemStatus(inc.id, 'ACK')}
            onReview={() => setItemStatus(inc.id, 'REVIEWED')}
            onClose={() => setItemStatus(inc.id, 'CLOSED')}
            onFalse={() => setItemStatus(inc.id, 'FALSE_POSITIVE')}
            onNote={(text) => setItemStatus(inc.id, getStatus(inc.id), text)}
            onDelete={() => deleteRecording(inc)}/>
        ))
      )}

      {/* ── Rich detail modal (shared component) ───────────────── */}
      <IncidentDetailModal
        recordingId={openId}
        onClose={() => setOpenId(null)}/>

      {/* Inline keyframes for the sticky banner pulse */}
      <style>{`
        @keyframes pulseAlert {
          0%,100% { box-shadow: 0 0 32px rgba(239,68,68,0.25); }
          50%     { box-shadow: 0 0 48px rgba(239,68,68,0.45); }
        }
      `}</style>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────────────────────

function AlertCard({ inc, status, note, onOpen, onAck, onReview, onClose, onFalse, onNote, onDelete }) {
  const sev    = SEV[inc.severity] || SEV.NORMAL
  const stMeta = STATUS_META[status] || STATUS_META.NEW
  const [showNote, setShowNote] = useState(false)
  const [tmpNote, setTmpNote]   = useState(note)

  return (
    <div style={{ padding:'16px 18px', marginBottom:'12px', borderRadius:'14px',
      background:`linear-gradient(135deg, ${sev.bg}, rgba(255,255,255,0.02))`,
      border:`1px solid ${status === 'NEW' ? sev.border : '#1F2937'}`,
      boxShadow: status === 'NEW' ? sev.glow : 'none',
      transition:'all .25s ease' }}>
      <div style={{ display:'flex', alignItems:'flex-start', gap:'14px' }}>

        {/* Score ring */}
        <ScoreRing score={inc.score} severity={inc.severity} size={64}/>

        {/* Main info */}
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ display:'flex', alignItems:'center', gap:'8px',
            marginBottom:'6px', flexWrap:'wrap' }}>
            <SeverityChip severity={inc.severity}/>
            <StatusChip status={status}/>
            <span style={{ fontSize:'10px', color:'#94A3B8', fontWeight:600 }}>
              {inc.toneLabel}
            </span>
          </div>
          <div onClick={onOpen}
            style={{ fontSize:'14px', fontWeight:700, color:'#F1F5F9',
              cursor:'pointer', overflow:'hidden', textOverflow:'ellipsis',
              whiteSpace:'nowrap', marginBottom:'4px' }}
            onMouseEnter={e => e.currentTarget.style.color = '#60A5FA'}
            onMouseLeave={e => e.currentTarget.style.color = '#F1F5F9'}>
            {inc.filename}
          </div>
          <div style={{ fontSize:'11px', color:'#64748B', display:'flex',
            gap:'10px', flexWrap:'wrap' }}>
            <span>◎ {inc.officerId}</span>
            <span>· {inc.violationCount} violations</span>
            <span>· {fmtRel(inc.uploadedAt)}</span>
          </div>
          {note && (
            <div style={{ marginTop:'8px', padding:'7px 11px', borderRadius:'8px',
              background:'rgba(59,130,246,0.06)', border:'1px solid rgba(59,130,246,0.20)',
              borderLeft:'3px solid #3B82F6', fontSize:'11px', color:'#CBD5E1',
              fontStyle:'italic' }}>
              📝 {note}
            </div>
          )}
          {showNote && (
            <div style={{ marginTop:'8px', display:'flex', gap:'6px' }}>
              <input value={tmpNote} onChange={e => setTmpNote(e.target.value)}
                placeholder="Add a note for the team..."
                style={{ flex:1, padding:'6px 10px', fontSize:'11px',
                  background:'rgba(0,0,0,0.30)', color:'#F1F5F9',
                  border:'1px solid #1F2937', borderRadius:'7px', outline:'none' }}/>
              <button onClick={() => { onNote(tmpNote); setShowNote(false) }}
                style={tinyBtn('#3B82F6')}>Save</button>
              <button onClick={() => setShowNote(false)}
                style={tinyBtn('#64748B')}>Cancel</button>
            </div>
          )}
        </div>

        {/* Actions */}
        <div style={{ display:'flex', flexDirection:'column', gap:'5px',
          alignItems:'flex-end' }}>
          <button onClick={onOpen} style={primaryBtnStyle}>Open ›</button>
          <div style={{ display:'flex', gap:'5px' }}>
            {status === 'NEW' && (
              <button onClick={onAck}    style={tinyBtn('#F59E0B')} title="Acknowledge">◐ ACK</button>
            )}
            {status !== 'REVIEWED' && status !== 'CLOSED' && (
              <button onClick={onReview} style={tinyBtn('#3B82F6')} title="Mark reviewed">✓ Review</button>
            )}
            {status !== 'CLOSED' && (
              <button onClick={onClose}  style={tinyBtn('#10B981')} title="Close incident">● Close</button>
            )}
            {status !== 'FALSE_POSITIVE' && (
              <button onClick={onFalse}  style={tinyBtn('#64748B')} title="Mark false positive">✗ FP</button>
            )}
            <button onClick={() => setShowNote(!showNote)}
              style={tinyBtn('#94A3B8')} title="Add note">📝</button>
            <button onClick={onDelete}
              style={dangerBtn} title="Permanently delete from database">🗑 Delete</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function KpiTile({ label, val, color }) {
  return (
    <div style={{ padding:'14px 18px', borderRadius:'12px',
      background:`linear-gradient(135deg, ${color}15, rgba(255,255,255,0.02))`,
      border:`1px solid ${color}30` }}>
      <div style={{ fontSize:'9px', color:'#64748B', fontWeight:800,
        letterSpacing:'0.10em', textTransform:'uppercase' }}>{label}</div>
      <div style={{ fontSize:'28px', fontWeight:900, color,
        marginTop:'4px', lineHeight:1, letterSpacing:'-0.02em',
        fontVariantNumeric:'tabular-nums' }}>{val}</div>
    </div>
  )
}

function SeverityChip({ severity }) {
  const s = SEV[severity] || SEV.NORMAL
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:'5px',
      padding:'3px 9px', borderRadius:'7px', fontSize:'10px', fontWeight:800,
      letterSpacing:'0.08em', textTransform:'uppercase',
      background:s.bg, color:s.color, border:`1px solid ${s.border}` }}>
      <span style={{ width:6, height:6, borderRadius:'50%',
        background:s.color, boxShadow:`0 0 6px ${s.color}` }}/>
      {severity}
    </span>
  )
}

function StatusChip({ status }) {
  const m = STATUS_META[status] || STATUS_META.NEW
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:'5px',
      padding:'2px 8px', borderRadius:'6px', fontSize:'9px', fontWeight:800,
      letterSpacing:'0.06em', textTransform:'uppercase',
      color:m.color, background:`${m.color}15`, border:`1px solid ${m.color}40` }}>
      <span>{m.icon}</span>{m.label}
    </span>
  )
}

function ScoreRing({ score, severity, size = 64 }) {
  const sev = SEV[severity] || SEV.NORMAL
  const r = size / 2 - 5
  const circ = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(100, score)) / 100
  return (
    <div style={{ position:'relative', width:size, height:size, flexShrink:0 }}>
      <svg width={size} height={size} style={{ transform:'rotate(-90deg)' }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none"
          stroke="rgba(255,255,255,0.06)" strokeWidth="5"/>
        <circle cx={size/2} cy={size/2} r={r} fill="none"
          stroke={sev.color} strokeWidth="5" strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - pct)}/>
      </svg>
      <div style={{ position:'absolute', inset:0, display:'flex',
        flexDirection:'column', alignItems:'center', justifyContent:'center' }}>
        <div style={{ fontSize:'16px', fontWeight:900, color:sev.color,
          lineHeight:1 }}>{score}</div>
      </div>
    </div>
  )
}

function Toggle({ label, on, onChange }) {
  return (
    <button onClick={() => onChange(!on)}
      style={{ display:'inline-flex', alignItems:'center', gap:'7px',
        padding:'7px 12px', borderRadius:'9px', fontSize:'11px',
        fontWeight:700, cursor:'pointer', transition:'all .2s',
        background: on ? 'rgba(16,185,129,0.10)' : 'rgba(255,255,255,0.02)',
        color: on ? '#10B981' : '#94A3B8',
        border:`1px solid ${on ? 'rgba(16,185,129,0.30)' : '#1F2937'}` }}>
      <span style={{ width:6, height:6, borderRadius:'50%',
        background: on ? '#10B981' : '#475569' }}/>
      {label}
    </button>
  )
}

function FilterGroup({ label, children }) {
  return (
    <div style={{ display:'inline-flex', alignItems:'center', gap:'6px',
      padding:'4px 8px', borderRadius:'10px',
      background:'rgba(255,255,255,0.015)', border:'1px solid #1F2937' }}>
      <span style={{ fontSize:'9px', color:'#64748B', fontWeight:800,
        letterSpacing:'0.10em', textTransform:'uppercase',
        marginRight:'4px' }}>{label}</span>
      {children}
    </div>
  )
}

function Pill({ on, onClick, color = '#3B82F6', children }) {
  return (
    <button onClick={onClick}
      style={{ padding:'5px 11px', borderRadius:'7px', fontSize:'11px',
        fontWeight:700, cursor:'pointer', transition:'all .2s',
        background: on ? `${color}20` : 'rgba(255,255,255,0.02)',
        color: on ? color : '#94A3B8',
        border:`1px solid ${on ? `${color}50` : '#1F2937'}` }}>
      {children}
    </button>
  )
}

function Empty({ children, error }) {
  return (
    <div style={{ padding:'56px 24px', borderRadius:'14px', textAlign:'center',
      background:'rgba(255,255,255,0.02)',
      border:`1px solid ${error ? 'rgba(239,68,68,0.25)' : '#1F2937'}`,
      color: error ? '#EF4444' : '#64748B', fontSize:'13px' }}>
      {children}
    </div>
  )
}

// Button styles
const primaryBtnStyle = {
  background:'linear-gradient(135deg, #3B82F6, #6366F1)',
  color:'#fff', border:'none', padding:'7px 14px', borderRadius:'8px',
  fontSize:'11px', fontWeight:800, cursor:'pointer', letterSpacing:'0.04em',
  boxShadow:'0 4px 12px rgba(59,130,246,0.30)',
}

const refreshBtnStyle = {
  fontSize:'11px', color:'#3B82F6', background:'rgba(59,130,246,0.08)',
  border:'1px solid rgba(59,130,246,0.25)', padding:'7px 14px',
  borderRadius:'9px', cursor:'pointer', fontWeight:700,
}

const tinyBtn = (c) => ({
  background:`${c}15`, color: c, border:`1px solid ${c}40`,
  padding:'4px 10px', borderRadius:'7px', fontSize:'10px', fontWeight:700,
  cursor:'pointer', letterSpacing:'0.04em', whiteSpace:'nowrap',
})

// Destructive action — red border + ghost background so it's visually
// distinct from the safer workflow buttons next to it.
const dangerBtn = {
  background:'rgba(239,68,68,0.06)',
  color:'#EF4444',
  border:'1px solid rgba(239,68,68,0.45)',
  padding:'4px 10px', borderRadius:'7px',
  fontSize:'10px', fontWeight:800,
  cursor:'pointer', letterSpacing:'0.04em', whiteSpace:'nowrap',
}
