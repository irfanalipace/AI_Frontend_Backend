import React, { useState, useEffect, useMemo } from 'react'
import ApiService           from '../services/api'
import IncidentDetailModal  from '../components/IncidentDetailModal'

// ───────────────────────────────────────────────────────────────────
// Severity-driven palette — keeps Critical/Warning/Normal visually
// distinct everywhere (filter pills, list rows, score ring, detail).
// ───────────────────────────────────────────────────────────────────
const SEV = {
  CRITICAL: { color:'#EF4444', bg:'rgba(239,68,68,0.10)',  border:'rgba(239,68,68,0.30)',  glow:'0 0 24px rgba(239,68,68,0.18)' },
  WARNING:  { color:'#F59E0B', bg:'rgba(245,158,11,0.10)', border:'rgba(245,158,11,0.30)', glow:'0 0 24px rgba(245,158,11,0.15)' },
  NORMAL:   { color:'#10B981', bg:'rgba(16,185,129,0.10)', border:'rgba(16,185,129,0.30)', glow:'0 0 24px rgba(16,185,129,0.15)' },
  ALL:      { color:'#3B82F6', bg:'rgba(59,130,246,0.10)', border:'rgba(59,130,246,0.30)', glow:'0 0 24px rgba(59,130,246,0.15)' },
}

const TONE_COLOR = {
  NORMAL:'#10B981', HARSH:'#F59E0B', ANGRY:'#EF4444',
  BRIBE_TONE:'#8B5CF6', LOUD:'#F59E0B', UNKNOWN:'#64748B',
}

const fmtRelative = (iso) => {
  const t = new Date(iso).getTime()
  const diff = Date.now() - t
  const m = Math.round(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return d < 7 ? `${d}d ago` : new Date(iso).toLocaleDateString()
}

function ScoreRing({ score, severity, size = 96 }) {
  const sev = SEV[severity] || SEV.NORMAL
  const r = size / 2 - 6
  const circ = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(100, score)) / 100
  return (
    <div style={{ position:'relative', width:size, height:size, flexShrink:0 }}>
      <svg width={size} height={size} style={{ transform:'rotate(-90deg)' }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none"
          stroke="rgba(255,255,255,0.06)" strokeWidth="6"/>
        <circle cx={size/2} cy={size/2} r={r} fill="none"
          stroke={sev.color} strokeWidth="6" strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - pct)}
          style={{ transition:'stroke-dashoffset 0.6s ease' }}/>
      </svg>
      <div style={{ position:'absolute', inset:0, display:'flex',
        flexDirection:'column', alignItems:'center', justifyContent:'center' }}>
        <div style={{ fontSize: size > 80 ? '22px' : '16px',
          fontWeight:800, color:sev.color, lineHeight:1 }}>{score}</div>
        <div style={{ fontSize:'9px', color:'#64748B',
          letterSpacing:'0.08em', marginTop:'2px', fontWeight:700 }}>/100</div>
      </div>
    </div>
  )
}

function SeverityChip({ severity }) {
  const sev = SEV[severity] || SEV.NORMAL
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:'6px',
      padding:'4px 10px', borderRadius:'8px', fontSize:'10px', fontWeight:800,
      letterSpacing:'0.08em', background:sev.bg, color:sev.color,
      border:`1px solid ${sev.border}`, textTransform:'uppercase' }}>
      <span style={{ width:6, height:6, borderRadius:'50%', background:sev.color,
        boxShadow:`0 0 6px ${sev.color}` }}/>
      {severity}
    </span>
  )
}

export default function Incidents({ alerts = [], markRead, clearAlerts }) {
  const [items,    setItems]    = useState([])
  const [loading,  setLoading]  = useState(true)
  const [err,      setErr]      = useState(null)
  const [filter,   setFilter]   = useState('ALL')
  const [search,   setSearch]   = useState('')
  const [openId,   setOpenId]   = useState(null)   // recordingId opened in the modal
  const [stats,    setStats]    = useState({ total:0, critical:0, warning:0, normal:0 })

  // ── Load list (live MSSQL via .NET) ────────────────────────────
  const load = async () => {
    setLoading(true); setErr(null)
    try {
      const params = { page: 1, pageSize: 200 }
      if (filter !== 'ALL') params.severity = filter
      const [list, st] = await Promise.all([
        ApiService.dotnetRecordings(params),
        ApiService.dotnetRecordingStats(),
      ])
      setItems(list.data.items || [])
      setStats({
        total:    st.data.totalRecordings || 0,
        critical: st.data.critical        || 0,
        warning:  st.data.warning         || 0,
        normal:   st.data.normal          || 0,
      })
    } catch (e) {
      setErr('Cannot reach .NET backend on :8080. Is it running?')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() /* eslint-disable-next-line */ }, [filter])

  // Auto-refresh — list only, do not yank the open detail.
  useEffect(() => {
    const t = setInterval(load, 20000)
    return () => clearInterval(t)
    // eslint-disable-next-line
  }, [filter])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return items
    return items.filter(i =>
      (i.filename   || '').toLowerCase().includes(q) ||
      (i.officerId  || '').toLowerCase().includes(q) ||
      (i.toneLabel  || '').toLowerCase().includes(q)
    )
  }, [items, search])

  const unread = alerts.filter(a => !a.read)

  return (
    <div style={{ padding:'32px 36px', minHeight:'100vh', color:'#F1F5F9' }}>

      {/* ── Header ──────────────────────────────────────────────── */}
      <div style={{ display:'flex', alignItems:'flex-end',
        justifyContent:'space-between', marginBottom:'28px', gap:'24px', flexWrap:'wrap' }}>
        <div>
          <div style={{ display:'flex', alignItems:'center', gap:'12px', marginBottom:'8px' }}>
            <div style={{ width:42, height:42, borderRadius:'12px',
              background:'linear-gradient(135deg, #EF4444, #DC2626)',
              display:'flex', alignItems:'center', justifyContent:'center',
              fontSize:'20px', color:'#fff', fontWeight:900,
              boxShadow:'0 8px 20px rgba(239,68,68,0.35)' }}>⚑</div>
            <div>
              <h1 style={{ fontSize:'26px', fontWeight:800, margin:0,
                letterSpacing:'-0.02em', color:'#F1F5F9' }}>Incidents</h1>
              <div style={{ fontSize:'12px', color:'#64748B', marginTop:'2px' }}>
                Live MSSQL · {stats.total} recordings analysed by Gemini AI
              </div>
            </div>
          </div>
        </div>

        <div style={{ display:'flex', gap:'10px', alignItems:'center' }}>
          {unread.length > 0 && (
            <span style={{ background:'rgba(239,68,68,0.15)', color:'#EF4444',
              border:'1px solid rgba(239,68,68,0.3)', fontSize:'11px', fontWeight:800,
              padding:'6px 12px', borderRadius:'8px', letterSpacing:'0.05em' }}>
              {unread.length} NEW LIVE ALERTS
            </span>
          )}
          {unread.length > 0 && (
            <button onClick={clearAlerts}
              style={{ fontSize:'11px', color:'#94A3B8', background:'transparent',
                border:'1px solid #1F2937', padding:'6px 12px', borderRadius:'8px',
                cursor:'pointer', fontWeight:600 }}>Clear</button>
          )}
          <button onClick={load}
            style={{ fontSize:'11px', color:'#3B82F6', background:'rgba(59,130,246,0.08)',
              border:'1px solid rgba(59,130,246,0.25)', padding:'6px 14px',
              borderRadius:'8px', cursor:'pointer', fontWeight:700 }}>↻ Refresh</button>
        </div>
      </div>

      {/* ── Live alert banners (websocket pushed) ─────────────────── */}
      {unread.slice(0, 3).map(a => {
        const sev = SEV[a.severity] || SEV.WARNING
        return (
          <div key={a._id} onClick={() => markRead && markRead(a._id)}
            style={{ display:'flex', alignItems:'center', gap:'14px',
              padding:'12px 18px', marginBottom:'10px', borderRadius:'12px',
              cursor:'pointer', background:sev.bg, border:`1px solid ${sev.border}`,
              boxShadow:sev.glow }}>
            <div style={{ width:8, height:8, borderRadius:'50%', background:sev.color,
              animation:'pulse 1.2s infinite', boxShadow:`0 0 10px ${sev.color}` }}/>
            <SeverityChip severity={a.severity}/>
            <span style={{ fontSize:'13px', color:'#F1F5F9', fontWeight:700 }}>
              {a.officer_id}
            </span>
            <span style={{ fontSize:'12px', color:'#94A3B8' }}>
              Score {a.total_score}/100 · {a.violations?.length || 0} violations
            </span>
            <span style={{ fontSize:'11px', color:'#64748B', flex:1, textAlign:'right' }}>
              {new Date(a.timestamp).toLocaleTimeString()} · tap to dismiss
            </span>
          </div>
        )
      })}

      {/* ── Filter row ──────────────────────────────────────────── */}
      <div style={{ display:'flex', gap:'8px', marginBottom:'18px',
        flexWrap:'wrap', alignItems:'center' }}>
        {[
          { key:'ALL',      count: stats.total },
          { key:'CRITICAL', count: stats.critical },
          { key:'WARNING',  count: stats.warning },
          { key:'NORMAL',   count: stats.normal },
        ].map(({ key, count }) => {
          const sev = SEV[key]
          const active = filter === key
          return (
            <button key={key}
              onClick={() => setFilter(key)}
              style={{ display:'inline-flex', alignItems:'center', gap:'8px',
                padding:'8px 16px', borderRadius:'10px', fontSize:'12px',
                fontWeight:700, letterSpacing:'0.04em', cursor:'pointer',
                transition:'all .2s',
                background: active ? sev.bg : 'rgba(255,255,255,0.02)',
                color:    active ? sev.color : '#94A3B8',
                border: `1px solid ${active ? sev.border : '#1F2937'}`,
                boxShadow: active ? sev.glow : 'none' }}>
              {key}
              <span style={{ fontSize:'10px', padding:'1px 7px', borderRadius:'6px',
                background: active ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)',
                color: active ? sev.color : '#64748B' }}>{count}</span>
            </button>
          )
        })}

        <input
          placeholder="Search filename, officer, tone..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ marginLeft:'auto', minWidth:'260px',
            padding:'9px 14px', fontSize:'12px',
            background:'rgba(255,255,255,0.03)', color:'#F1F5F9',
            border:'1px solid #1F2937', borderRadius:'10px', outline:'none' }}/>
      </div>

      {/* ── Full-width list, click → modal ───────────────────────── */}
      <div>
        {err ? (
          <div style={{ padding:'32px', borderRadius:'14px', textAlign:'center',
            background:'rgba(239,68,68,0.06)',
            border:'1px solid rgba(239,68,68,0.25)', color:'#EF4444' }}>
            <div style={{ fontSize:'13px', fontWeight:700, marginBottom:'6px' }}>
              Backend unreachable
            </div>
            <div style={{ fontSize:'12px', color:'#94A3B8' }}>{err}</div>
          </div>
        ) : loading ? (
          <div style={{ padding:'48px', textAlign:'center',
            color:'#64748B', fontSize:'12px' }}>Loading from MSSQL...</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding:'48px', borderRadius:'14px', textAlign:'center',
            background:'rgba(255,255,255,0.02)', border:'1px solid #1F2937',
            color:'#64748B' }}>
            <div style={{ fontSize:'32px', marginBottom:'10px', opacity:0.4 }}>⚑</div>
            <div style={{ fontSize:'13px' }}>
              {search ? 'No incidents match your search' : 'No incidents recorded yet'}
            </div>
            <div style={{ fontSize:'11px', color:'#475569', marginTop:'6px' }}>
              Drop videos into bodycam_dotnet/WatchFolder/Inbox/
            </div>
          </div>
        ) : (
          <div style={{ display:'grid',
            gridTemplateColumns:'repeat(auto-fill, minmax(420px, 1fr))',
            gap:'12px' }}>
            {filtered.map(inc => {
              // Mute the tone chip when the SVM heard ANGRY/HARSH/BRIBE
              // but the overall severity stayed NORMAL (acoustic-only,
              // no abusive language). Keeps the card visually coherent
              // with the actual severity band.
              const acousticOnly =
                /ANGRY|HARSH|BRIBE/.test(inc.toneLabel || '') &&
                inc.severity === 'NORMAL'
              const tone = acousticOnly
                ? '#94A3B8'
                : (TONE_COLOR[inc.toneLabel] || '#64748B')
              const sev  = SEV[inc.severity] || SEV.NORMAL
              return (
                <div key={inc.id} onClick={() => setOpenId(inc.id)}
                  onMouseEnter={e => {
                    e.currentTarget.style.transform = 'translateY(-2px)'
                    e.currentTarget.style.boxShadow = sev.glow
                    e.currentTarget.style.borderColor = sev.border
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.transform = 'translateY(0)'
                    e.currentTarget.style.boxShadow = 'none'
                    e.currentTarget.style.borderColor = '#1F2937'
                  }}
                  style={{ padding:'16px 18px', borderRadius:'14px',
                    cursor:'pointer', transition:'all .25s ease',
                    background:`linear-gradient(135deg, ${sev.bg}, rgba(255,255,255,0.02))`,
                    border:`1px solid #1F2937` }}>
                  <div style={{ display:'flex', alignItems:'center', gap:'14px' }}>
                    <ScoreRing score={inc.score} severity={inc.severity} size={68}/>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:'8px',
                        marginBottom:'6px', flexWrap:'wrap' }}>
                        <SeverityChip severity={inc.severity}/>
                        <span title={acousticOnly
                            ? `Voice classified ${inc.toneLabel} but no abusive language detected — severity stays NORMAL`
                            : undefined}
                          style={{ fontSize:'10px', color:tone, fontWeight:800,
                            padding:'3px 8px', borderRadius:'6px',
                            background:`${tone}15`, border:`1px solid ${tone}40`,
                            letterSpacing:'0.04em',
                            opacity: acousticOnly ? 0.85 : 1 }}>
                          {inc.toneLabel || 'UNKNOWN'}
                          {acousticOnly && (
                            <span style={{ marginLeft:'5px', fontSize:'8px',
                              opacity:0.75, fontWeight:700 }}>
                              · acoustic only
                            </span>
                          )}
                        </span>
                      </div>
                      <div style={{ fontSize:'13px', fontWeight:700, color:'#F1F5F9',
                        overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                        marginBottom:'4px' }}>{inc.filename}</div>
                      <div style={{ fontSize:'11px', color:'#64748B', display:'flex',
                        gap:'10px', flexWrap:'wrap' }}>
                        <span>◎ {inc.officerId}</span>
                        <span>· {inc.violationCount} violations</span>
                        <span>· {fmtRelative(inc.uploadedAt)}</span>
                      </div>
                    </div>
                    <div style={{ fontSize:'11px', color:'#64748B',
                      fontWeight:700, letterSpacing:'0.04em' }}>OPEN ›</div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Detail modal (rich Gemini + acoustic + visual breakdown) ── */}
      <IncidentDetailModal
        recordingId={openId}
        onClose={() => setOpenId(null)}/>
    </div>
  )
}

