import React, { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
import { useSocket } from './hooks/useSocket'
import Dashboard     from './pages/Dashboard'
import Upload        from './pages/Upload'
import GeminiAnalyse from './pages/GeminiAnalyse'
import VideoAnalysis from './pages/VideoAnalysis'
import LiveStream    from './pages/LiveStream'
import Incidents     from './pages/Incidents'
import Samples       from './pages/Samples'
import Officers      from './pages/Officers'
import AlertCenter   from './pages/AlertCenter'
import ApiService    from './services/api'

// ──────────────────────────────────────────────────────────────────
// Sidebar nav — grouped, single-line items, SVG icons.
// ──────────────────────────────────────────────────────────────────
const NAV_GROUPS = [
  {
    title: 'Monitoring',
    items: [
      { to:'/',               label:'Dashboard',      icon:'dashboard'  },
      { to:'/alerts',         label:'Alert Center',   icon:'bell',  badge:'alerts' },
      { to:'/video-analysis', label:'Video Analysis', icon:'video'      },
      { to:'/live',           label:'Live Stream',    icon:'broadcast', live:true },
    ],
  },
  {
    title: 'Analysis',
    items: [
      { to:'/upload', label:'Upload Audio',    icon:'upload' },
      { to:'/gemini', label:'Gemini Analysis', icon:'sparkle' },
    ],
  },
  {
    title: 'Records',
    items: [
      { to:'/incidents', label:'Incidents',    icon:'flag'    },
      { to:'/officers',  label:'Officers',     icon:'users'   },
      // { to:'/samples',   label:'Test Samples', icon:'archive' },
    ],
  },
]

export default function App() {
  const { connected, alerts, markRead, clearAlerts, liveStatus } = useSocket()
  const [info,        setInfo]        = useState(null)
  const [dotnetStats, setDotnetStats] = useState(null)
  const [dotnetUp,    setDotnetUp]    = useState(true)

  const unread = alerts.filter(a => !a.read).length
  const latest = alerts[0]

  useEffect(() => {
    ApiService.health().then(r => setInfo(r.data)).catch(() => {})
  }, [])

  // Live MSSQL probe — refreshes every 30s.
  useEffect(() => {
    let cancel = false
    const tick = () => {
      ApiService.dotnetRecordingStats({ timeout: 6000 })
        .then(r => { if (!cancel) { setDotnetStats(r.data); setDotnetUp(true) } })
        .catch(() => { if (!cancel) setDotnetUp(false) })
    }
    tick()
    const id = setInterval(tick, 30000)
    return () => { cancel = true; clearInterval(id) }
  }, [])

  return (
    <BrowserRouter>
      <div style={{ display:'flex', minHeight:'100vh', background:'#0B0F1A' }}>

        {/* ╔══════════════════ Sidebar ══════════════════╗ */}
        <aside style={{ width:236, flexShrink:0,
          background:'linear-gradient(180deg, #0F172A 0%, #0B0F1A 100%)',
          borderRight:'1px solid #1E293B',
          display:'flex', flexDirection:'column',
          height:'100vh', position:'sticky', top:0 }}>

          {/* ── Brand ───────────────────────────────────── */}
          <div style={{ padding:'20px 18px 14px',
            borderBottom:'1px solid #1E293B' }}>
            <div style={{ display:'flex', alignItems:'center', gap:'11px' }}>
              <div style={{ width:38, height:38, borderRadius:'10px',
                background:'linear-gradient(135deg, #3B82F6, #6366F1)',
                display:'flex', alignItems:'center', justifyContent:'center',
                fontSize:'13px', fontWeight:900, color:'#fff',
                letterSpacing:'-0.02em',
                boxShadow:'0 6px 16px rgba(59,130,246,0.30)' }}>EO</div>
              <div style={{ minWidth:0 }}>
                <div style={{ fontSize:'14px', fontWeight:800,
                  color:'#F1F5F9', letterSpacing:'-0.02em',
                  whiteSpace:'nowrap' }}>PERA Bodycam</div>
                <div style={{ fontSize:'9px', color:'#64748B',
                  letterSpacing:'0.10em', textTransform:'uppercase',
                  fontWeight:700, marginTop:'1px' }}>
                  Conduct Monitor
                </div>
              </div>
            </div>
          </div>

          {/* ── Live status pills ──────────────────────── */}
          <div style={{ padding:'12px 14px',
            borderBottom:'1px solid #1E293B',
            display:'flex', flexDirection:'column', gap:'4px' }}>
            <StatusRow ok={connected}
              label={connected ? 'Live socket' : 'Socket offline'}
              meta={connected ? 'online' : 'check Python'}/>
            <StatusRow ok={dotnetUp}
              label={dotnetUp ? 'MSSQL' : 'MSSQL offline'}
              meta={dotnetUp ? `${dotnetStats?.totalRecordings ?? 0} recs` : 'check .NET'}/>
          </div>

          {/* ── Navigation ─────────────────────────────── */}
          <nav style={{ flex:1, padding:'10px 8px', overflowY:'auto' }}>
            {NAV_GROUPS.map((group, gi) => (
              <div key={group.title}
                style={{ marginBottom: gi === NAV_GROUPS.length - 1 ? 0 : '12px' }}>
                <div style={{ fontSize:'9px', fontWeight:800, color:'#475569',
                  letterSpacing:'0.12em', textTransform:'uppercase',
                  padding:'8px 12px 6px' }}>
                  {group.title}
                </div>
                {group.items.map(item => (
                  <NavLink key={item.to} to={item.to} end={item.to === '/'}
                    style={({ isActive }) => ({
                      display:'flex', alignItems:'center', gap:'12px',
                      padding:'9px 11px', borderRadius:'9px', marginBottom:'1px',
                      textDecoration:'none', fontSize:'13px',
                      fontWeight: isActive ? 700 : 500,
                      background: isActive
                        ? 'linear-gradient(90deg, rgba(59,130,246,0.16), rgba(99,102,241,0.04))'
                        : 'transparent',
                      color: isActive ? '#F1F5F9' : '#94A3B8',
                      borderLeft: isActive
                        ? '2px solid #3B82F6'
                        : '2px solid transparent',
                      paddingLeft: isActive ? '10px' : '11px',
                      transition:'all .15s ease',
                    })}
                    onMouseEnter={e => {
                      if (!e.currentTarget.style.background.includes('linear-gradient'))
                        e.currentTarget.style.background = 'rgba(255,255,255,0.025)'
                    }}
                    onMouseLeave={e => {
                      if (!e.currentTarget.style.borderLeft.includes('#3B82F6'))
                        e.currentTarget.style.background = 'transparent'
                    }}>
                    <span style={{ display:'flex', width:18, height:18,
                      flexShrink:0, alignItems:'center', justifyContent:'center',
                      color: item.live ? '#EF4444' : 'currentColor',
                      animation: item.live ? 'liveGlow 2s infinite' : 'none' }}>
                      <Icon name={item.icon}/>
                    </span>
                    <span style={{ flex:1, whiteSpace:'nowrap' }}>{item.label}</span>

                    {/* Right-side affordances */}
                    {item.label === 'Incidents' && unread > 0 && (
                      <span style={{
                        background:'linear-gradient(135deg, #EF4444, #DC2626)',
                        color:'#fff', fontSize:'10px', fontWeight:800,
                        padding:'1px 7px', borderRadius:'8px', minWidth:'18px',
                        textAlign:'center',
                        boxShadow:'0 2px 6px rgba(239,68,68,0.40)' }}>{unread}</span>
                    )}
                    {item.label === 'Alert Center' && (dotnetStats?.critical ?? 0) > 0 && (
                      <span style={{
                        background:'linear-gradient(135deg, #EF4444, #DC2626)',
                        color:'#fff', fontSize:'10px', fontWeight:800,
                        padding:'1px 7px', borderRadius:'8px', minWidth:'18px',
                        textAlign:'center',
                        boxShadow:'0 2px 6px rgba(239,68,68,0.40)',
                        animation:'liveGlow 2s infinite' }}>
                        {dotnetStats.critical}
                      </span>
                    )}
                    {item.label === 'Live Stream' && liveStatus && (
                      <span style={{ background:'rgba(239,68,68,0.18)',
                        color:'#EF4444', fontSize:'9px', fontWeight:800,
                        padding:'2px 6px', borderRadius:'5px',
                        border:'1px solid rgba(239,68,68,0.30)',
                        letterSpacing:'0.06em' }}>LIVE</span>
                    )}
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>

          {/* ── Latest alert (compact, only when present) ─── */}
          {latest && (
            <div style={{ margin:'10px 12px 0', padding:'10px 12px',
              borderRadius:'10px',
              background: latest.severity === 'CRITICAL'
                ? 'rgba(239,68,68,0.10)' : 'rgba(245,158,11,0.10)',
              border: `1px solid ${latest.severity === 'CRITICAL'
                ? 'rgba(239,68,68,0.25)' : 'rgba(245,158,11,0.25)'}` }}>
              <div style={{ display:'flex', alignItems:'center', gap:'7px',
                marginBottom:'4px' }}>
                <span style={{ width:6, height:6, borderRadius:'50%',
                  background: latest.severity === 'CRITICAL' ? '#EF4444' : '#F59E0B',
                  boxShadow: `0 0 6px ${latest.severity === 'CRITICAL' ? '#EF4444' : '#F59E0B'}` }}/>
                <span style={{ fontSize:'9px', fontWeight:800,
                  letterSpacing:'0.10em', textTransform:'uppercase',
                  color: latest.severity === 'CRITICAL' ? '#EF4444' : '#F59E0B' }}>
                  Latest · {latest.severity}
                </span>
              </div>
              <div style={{ fontSize:'12px', color:'#F1F5F9',
                fontWeight:700 }}>
                {latest.officer_id}
                <span style={{ color:'#64748B', fontWeight:600,
                  marginLeft:'6px' }}>· {latest.total_score}/100</span>
              </div>
            </div>
          )}

          {/* ── Footer ──────────────────────────────────── */}
          <div style={{ padding:'12px 18px',
            borderTop:'1px solid #1E293B', marginTop:'10px',
            fontSize:'10px', color:'#475569', lineHeight:1.5 }}>
            <div style={{ fontWeight:700, color:'#64748B' }}>v5.0 · 1081 keywords</div>
            <div style={{ color:'#334155' }}>Gemini · Whisper · MSSQL</div>
          </div>
        </aside>

        {/* ╔══════════════════ Main ══════════════════╗ */}
        <main style={{ flex:1, overflow:'auto', background:'#0B0F1A' }}>
          <Routes>
            <Route path="/"               element={<Dashboard />} />
            <Route path="/upload"         element={<Upload />} />
            <Route path="/gemini"         element={<GeminiAnalyse />} />
            <Route path="/video-analysis" element={<VideoAnalysis />} />
            <Route path="/live"           element={<LiveStream liveStatus={liveStatus} />} />
            <Route path="/samples"        element={<Samples />} />
            <Route path="/alerts"         element={<AlertCenter alerts={alerts} markRead={markRead} />} />
            <Route path="/incidents"      element={<Incidents alerts={alerts} markRead={markRead} clearAlerts={clearAlerts} />} />
            <Route path="/officers"       element={<Officers />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}

// ──────────────────────────────────────────────────────────────────
// Sidebar primitives
// ──────────────────────────────────────────────────────────────────

function StatusRow({ ok, label, meta }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:'8px',
      padding:'5px 8px', borderRadius:'7px',
      background: ok ? 'rgba(16,185,129,0.06)' : 'rgba(239,68,68,0.06)',
      border:`1px solid ${ok ? 'rgba(16,185,129,0.18)' : 'rgba(239,68,68,0.20)'}` }}>
      <span style={{ width:7, height:7, borderRadius:'50%',
        background: ok ? '#10B981' : '#EF4444',
        boxShadow: ok
          ? '0 0 6px rgba(16,185,129,0.55)'
          : '0 0 6px rgba(239,68,68,0.55)',
        animation: ok ? 'none' : 'pulse 1.5s infinite', flexShrink:0 }}/>
      <span style={{ fontSize:'11px', color: ok ? '#34D399' : '#F87171',
        fontWeight:700, flex:1, whiteSpace:'nowrap',
        overflow:'hidden', textOverflow:'ellipsis' }}>{label}</span>
      <span style={{ fontSize:'10px', color:'#64748B',
        fontWeight:600, whiteSpace:'nowrap' }}>{meta}</span>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────
// Inline SVG icon set — stroke-based, currentColor.
// Lightweight (no icon library), 18×18, 1.6 stroke for crispness.
// ──────────────────────────────────────────────────────────────────
function Icon({ name, size = 18 }) {
  const common = {
    width: size, height: size, viewBox: '0 0 24 24',
    fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
    strokeLinecap: 'round', strokeLinejoin: 'round',
  }
  switch (name) {
    case 'dashboard':
      return (
        <svg {...common}>
          <rect x="3"  y="3"  width="7" height="9" rx="1.5"/>
          <rect x="14" y="3"  width="7" height="5" rx="1.5"/>
          <rect x="14" y="12" width="7" height="9" rx="1.5"/>
          <rect x="3"  y="16" width="7" height="5" rx="1.5"/>
        </svg>
      )
    case 'video':
      return (
        <svg {...common}>
          <rect x="2.5" y="6" width="14" height="12" rx="2"/>
          <path d="M16.5 10l5-3v10l-5-3z"/>
        </svg>
      )
    case 'broadcast':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="2"/>
          <path d="M16.5 7.5a6 6 0 0 1 0 9"/>
          <path d="M7.5 7.5a6 6 0 0 0 0 9"/>
          <path d="M19.5 4.5a10 10 0 0 1 0 15"/>
          <path d="M4.5 4.5a10 10 0 0 0 0 15"/>
        </svg>
      )
    case 'upload':
      return (
        <svg {...common}>
          <path d="M12 4v12"/>
          <path d="M7 9l5-5 5 5"/>
          <path d="M4 19h16"/>
        </svg>
      )
    case 'sparkle':
      return (
        <svg {...common}>
          <path d="M12 3l1.8 4.5L18 9l-4.2 1.5L12 15l-1.8-4.5L6 9l4.2-1.5z"/>
          <path d="M19 14l.9 2 2 .9-2 .9-.9 2-.9-2-2-.9 2-.9z"/>
          <path d="M5 16l.6 1.4 1.4.6-1.4.6L5 20l-.6-1.4L3 18l1.4-.6z"/>
        </svg>
      )
    case 'flag':
      return (
        <svg {...common}>
          <path d="M5 21V4"/>
          <path d="M5 4h11l-2 4 2 4H5"/>
        </svg>
      )
    case 'users':
      return (
        <svg {...common}>
          <circle cx="9" cy="8" r="3.5"/>
          <path d="M2.5 20a6.5 6.5 0 0 1 13 0"/>
          <circle cx="17" cy="9" r="2.5"/>
          <path d="M16 14.5a5 5 0 0 1 5.5 4.5"/>
        </svg>
      )
    case 'archive':
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="4" rx="1.5"/>
          <path d="M5 8v11a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V8"/>
          <path d="M10 12h4"/>
        </svg>
      )
    case 'bell':
      return (
        <svg {...common}>
          <path d="M6 16V10a6 6 0 1 1 12 0v6"/>
          <path d="M4.5 16h15"/>
          <path d="M10 19a2 2 0 0 0 4 0"/>
        </svg>
      )
    default:
      return <svg {...common}><circle cx="12" cy="12" r="3"/></svg>
  }
}
