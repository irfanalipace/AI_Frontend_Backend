import React, { useState, useEffect, useRef } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, AreaChart, Area, CartesianGrid, Legend,
} from 'recharts'
import { SeverityBadge, ScoreBar, SEV } from '../components/UI'
import ApiService from '../services/api'

/**
 * Dashboard — DB-backed live overview.
 *
 * All data comes from .NET endpoints that read MSSQL:
 *   GET /api/recordings/stats   → totals + counts per severity + top officers
 *   GET /api/recordings         → paged list (used for recent + violation aggregation)
 *   GET /api/watch-folder/status → watcher health + counters
 *
 * No mock / in-memory data. Survives Python and .NET restarts.
 */

const TOOLTIP_STYLE = {
  background:'rgba(15,23,42,0.95)',
  border:'1px solid rgba(51,65,85,0.50)',
  borderRadius:'10px',
  color:'#E2E8F0', fontSize:'12px',
  boxShadow:'0 8px 24px rgba(0,0,0,0.40)',
  padding:'8px 12px',
}

const CARD_STYLE = {
  background:'linear-gradient(180deg, #111827 0%, #0F172A 100%)',
  border:'1px solid rgba(51,65,85,0.40)',
  borderRadius:'18px', padding:'22px',
  boxShadow:'0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 24px rgba(0,0,0,0.18)',
}

const SECTION_LABEL = {
  fontSize:'10px', color:'#64748B', textTransform:'uppercase',
  letterSpacing:'0.10em', fontWeight:800, marginBottom:'14px', display:'block',
}

const SEV_COLORS = {
  CRITICAL: '#EF4444',
  WARNING:  '#F59E0B',
  NORMAL:   '#10B981',
}

// Format ISO timestamp → "5m ago" / "2h ago"
const formatAgo = (iso) => {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return '—'
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`
  return `${Math.round(sec / 86400)}d ago`
}

// Premium KPI tile with icon + gradient + hover lift
function KpiTile({ label, value, sub, color, icon, trend }) {
  return (
    <div
      style={{
        position:'relative', overflow:'hidden',
        background:`linear-gradient(180deg, ${color}11 0%, rgba(15,23,42,0.4) 100%)`,
        border:`1px solid ${color}33`,
        borderRadius:'18px', padding:'22px',
        boxShadow:'0 1px 0 rgba(255,255,255,0.04) inset, 0 4px 16px rgba(0,0,0,0.18)',
        transition:'all .25s cubic-bezier(0.4, 0, 0.2, 1)',
      }}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-3px)'; e.currentTarget.style.boxShadow = '0 1px 0 rgba(255,255,255,0.06) inset, 0 14px 28px rgba(0,0,0,0.30)' }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 1px 0 rgba(255,255,255,0.04) inset, 0 4px 16px rgba(0,0,0,0.18)' }}
    >
      <div style={{
        position:'absolute', top:'-30px', right:'-30px',
        width:'140px', height:'140px',
        background:`radial-gradient(circle, ${color}22 0%, transparent 70%)`,
        pointerEvents:'none', filter:'blur(20px)',
      }}/>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
        marginBottom:'12px', position:'relative' }}>
        <span style={{ fontSize:'10px', color:'#64748B', textTransform:'uppercase',
          letterSpacing:'0.10em', fontWeight:800 }}>
          {label}
        </span>
        {icon && <span style={{ fontSize:'18px', color, opacity:0.7 }}>{icon}</span>}
      </div>
      <div style={{ fontSize:'34px', fontWeight:900, color,
        marginBottom:'6px', letterSpacing:'-0.025em', lineHeight:1, position:'relative' }}>
        {value}
      </div>
      <div style={{ fontSize:'11px', color:'#64748B', position:'relative',
        display:'flex', alignItems:'center', gap:'6px' }}>
        {sub}
        {trend != null && (
          <span style={{
            fontSize:'10px', fontWeight:700,
            color: trend >= 0 ? '#34D399' : '#F87171',
            background: trend >= 0 ? 'rgba(16,185,129,0.10)' : 'rgba(239,68,68,0.10)',
            padding:'2px 7px', borderRadius:'6px',
          }}>
            {trend >= 0 ? '↑' : '↓'} {Math.abs(trend)}
          </span>
        )}
      </div>
    </div>
  )
}

export default function Dashboard() {
  const [stats,     setStats]     = useState(null)   // /api/recordings/stats
  const [recent,    setRecent]    = useState([])     // /api/recordings (recent 10)
  const [allItems,  setAllItems]  = useState([])     // /api/recordings (more, for charts)
  const [watcher,   setWatcher]   = useState(null)   // /api/watch-folder/status
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState(null)

  const aliveRef = useRef(true)

  const load = async () => {
    try {
      const [s, r, w] = await Promise.all([
        ApiService.dotnetRecordingStats(),
        ApiService.dotnetRecordings({ page: 1, pageSize: 50 }),
        ApiService.dotnetWatchStatus().catch(() => ({ data: null })),
      ])
      if (!aliveRef.current) return
      setStats(s.data || {})
      setRecent((r.data?.items || []).slice(0, 10))
      setAllItems(r.data?.items || [])
      setWatcher(w?.data || null)
      setError(null)
    } catch (e) {
      if (!aliveRef.current) return
      setError(e?.message || 'Could not reach .NET API')
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }

  useEffect(() => {
    aliveRef.current = true
    load()
    const t = setInterval(load, 15000)  // refresh every 15s
    return () => { aliveRef.current = false; clearInterval(t) }
  }, [])

  // ─── Loading state ────────────────────────────────────────────────
  if (loading) return (
    <div style={{ padding:'80px', textAlign:'center' }}>
      <div style={{ width:'40px', height:'40px', borderRadius:'50%',
        border:'3px solid rgba(51,65,85,0.30)',
        borderTopColor:'#60A5FA',
        animation:'spin .8s linear infinite', margin:'0 auto 18px' }}/>
      <div style={{ color:'#94A3B8', fontSize:'13px', fontWeight:600 }}>
        Loading dashboard…
      </div>
    </div>
  )

  // ─── Error state ──────────────────────────────────────────────────
  if (error) return (
    <div style={{ padding:'40px' }}>
      <div style={{
        background:'linear-gradient(135deg, rgba(239,68,68,0.10) 0%, rgba(15,23,42,0.4) 100%)',
        border:'1px solid rgba(239,68,68,0.30)',
        borderRadius:'18px', padding:'32px',
      }}>
        <div style={{ fontSize:'36px', marginBottom:'12px' }}>⚠️</div>
        <div style={{ fontWeight:800, color:'#F87171', marginBottom:'8px',
          fontSize:'18px', letterSpacing:'-0.01em' }}>
          .NET API Offline
        </div>
        <div style={{ fontSize:'13px', color:'#94A3B8', marginBottom:'14px', lineHeight:1.7 }}>
          Cannot reach the .NET backend at <code style={{
            background:'rgba(51,65,85,0.40)', padding:'2px 8px', borderRadius:'5px',
            color:'#CBD5E1' }}>{import.meta.env.VITE_DOTNET_API_URL || 'http://localhost:8080'}</code>. {error}
        </div>
        <code style={{
          display:'inline-block', fontSize:'12px',
          background:'rgba(15,23,42,0.80)', padding:'10px 16px',
          borderRadius:'10px', color:'#94A3B8',
          border:'1px solid rgba(51,65,85,0.40)',
          fontFamily:'ui-monospace, "SF Mono", Menlo, monospace',
        }}>
          cd c:/Projects/bodycam_dotnet && dotnet run --project PERA360.Api
        </code>
      </div>
    </div>
  )

  // ─── Derived data ─────────────────────────────────────────────────
  const total      = stats?.totalRecordings || 0
  const critical   = stats?.critical || 0
  const warning    = stats?.warning || 0
  const normal     = stats?.normal  || 0
  const last30Days = stats?.last30Days || 0
  const topOfficers = stats?.topOfficersByCritical || []

  // Severity pie data (live)
  const pieData = [
    { name:'Critical', value: critical, color: SEV_COLORS.CRITICAL },
    { name:'Warning',  value: warning,  color: SEV_COLORS.WARNING  },
    { name:'Normal',   value: normal,   color: SEV_COLORS.NORMAL   },
  ].filter(d => d.value > 0)

  const avgScore = total === 0 ? 0
    : Math.round((allItems.reduce((s, i) => s + (i.score || 0), 0)) / Math.max(1, allItems.length))

  // Tone-label distribution (live, from recent items)
  const toneCounts = allItems.reduce((acc, i) => {
    const k = i.toneLabel || 'NORMAL'
    acc[k] = (acc[k] || 0) + 1
    return acc
  }, {})
  const toneData = Object.entries(toneCounts).map(([name, v]) => ({ name, value: v }))

  // Top-officers bar data (live, from stats endpoint)
  const officerData = topOfficers.slice(0, 6).map(o => ({
    officer: o.officerId,
    critical: o.criticalCount,
    total: o.recordings,
  }))

  // Daily activity from recent items (last 7 days)
  const today = new Date(); today.setHours(0,0,0,0)
  const dailyMap = {}
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today.getTime() - i*86400000)
    const key = d.toISOString().slice(5, 10)  // MM-DD
    dailyMap[key] = { day: key, total: 0, critical: 0 }
  }
  allItems.forEach(it => {
    if (!it.uploadedAt) return
    const key = new Date(it.uploadedAt).toISOString().slice(5, 10)
    if (dailyMap[key]) {
      dailyMap[key].total += 1
      if (it.severity === 'CRITICAL') dailyMap[key].critical += 1
    }
  })
  const dailyData = Object.values(dailyMap)

  const watcherRunning = watcher?.enabled
  const inFlight = watcher?.counters?.in_flight || 0

  return (
    <div style={{ padding:'32px 36px', maxWidth:'1440px' }}>
      {/* Inline animations */}
      <style>{`
        @keyframes db-fadeIn { from { opacity:0; transform: translateY(6px); } to { opacity:1; transform: translateY(0); } }
        @keyframes db-pulseBg { 0%,100% { opacity:0.7; } 50% { opacity:1; } }
        .db-fade { animation: db-fadeIn .35s cubic-bezier(0.4, 0, 0.2, 1) both; }
      `}</style>

      {/* ── Header — gradient title + system health ───────────────────────── */}
      <div style={{ display:'flex', justifyContent:'space-between',
        alignItems:'flex-end', marginBottom:'28px', flexWrap:'wrap', gap:'16px' }}>
        <div>
          <div style={{ display:'flex', alignItems:'center', gap:'12px', marginBottom:'8px' }}>
            <div style={{
              width:'4px', height:'30px', borderRadius:'4px',
              background:'linear-gradient(180deg, #60A5FA, #6366F1)',
              boxShadow:'0 0 16px rgba(96,165,250,0.50)',
            }}/>
            <h1 style={{ fontSize:'28px', fontWeight:800,
              background:'linear-gradient(135deg, #F1F5F9 0%, #94A3B8 100%)',
              WebkitBackgroundClip:'text', backgroundClip:'text',
              WebkitTextFillColor:'transparent',
              margin:0, letterSpacing:'-0.025em' }}>
              Dashboard
            </h1>
            <span style={{
              fontSize:'10px', fontWeight:700, color:'#34D399',
              background:'rgba(16,185,129,0.10)',
              border:'1px solid rgba(16,185,129,0.30)',
              padding:'5px 12px', borderRadius:'7px', letterSpacing:'0.08em',
            }}>
              ● LIVE FROM MSSQL
            </span>
          </div>
          <p style={{ fontSize:'13px', color:'#64748B', lineHeight:1.7,
            margin:'0 0 0 16px', maxWidth:'820px' }}>
            Real-time PERA officer monitoring overview. All metrics are read straight
            from the database — no in-memory data, survives restarts.
          </p>
        </div>

        {/* System health pill */}
        <div style={{ display:'flex', flexDirection:'column', gap:'6px',
          alignItems:'flex-end', textAlign:'right' }}>
          <div style={{
            display:'inline-flex', alignItems:'center', gap:'10px',
            padding:'10px 16px', borderRadius:'12px',
            background: watcherRunning
              ? 'linear-gradient(135deg, rgba(16,185,129,0.12) 0%, rgba(15,23,42,0.4) 100%)'
              : 'linear-gradient(135deg, rgba(239,68,68,0.10) 0%, rgba(15,23,42,0.4) 100%)',
            border: watcherRunning
              ? '1px solid rgba(16,185,129,0.35)'
              : '1px solid rgba(239,68,68,0.35)',
          }}>
            <div style={{
              width:'8px', height:'8px', borderRadius:'50%',
              background: watcherRunning ? '#34D399' : '#F87171',
              boxShadow: `0 0 10px ${watcherRunning ? '#34D399' : '#F87171'}`,
              animation: watcherRunning ? 'db-pulseBg 2s ease-in-out infinite' : 'none',
            }}/>
            <span style={{ fontSize:'12px', fontWeight:700,
              color: watcherRunning ? '#34D399' : '#F87171' }}>
              {watcherRunning ? 'System Active' : 'Watcher Disabled'}
            </span>
          </div>
          <div style={{ fontSize:'10px', color:'#64748B', lineHeight:1.6 }}>
            {inFlight > 0 ? `${inFlight} file${inFlight === 1 ? '' : 's'} processing` : 'Idle'}
            {' · '}
            <span style={{ color:'#94A3B8', fontWeight:600 }}>auto-refresh every 15s</span>
          </div>
        </div>
      </div>

      {/* ── KPI Tiles (live data) ─────────────────────────────────────────── */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)',
        gap:'14px', marginBottom:'18px' }}>
        <KpiTile label="Total Recordings" icon="📊"
          value={total.toLocaleString()}
          sub="all-time analyzed"
          color="#60A5FA"/>
        <KpiTile label="Critical Alerts" icon="🚨"
          value={critical.toLocaleString()}
          sub={total > 0 ? `${Math.round(critical/total*100)}% of total` : 'no recordings yet'}
          color="#F87171"/>
        <KpiTile label="Warnings" icon="⚡"
          value={warning.toLocaleString()}
          sub={total > 0 ? `${Math.round(warning/total*100)}% of total` : 'no recordings yet'}
          color="#FBBF24"/>
        <KpiTile label="Last 30 Days" icon="📅"
          value={last30Days.toLocaleString()}
          sub={`avg score ${avgScore}/100`}
          color="#A78BFA"/>
      </div>

      {/* ── Charts row 1: severity pie + 7-day trend ──────────────────────── */}
      <div style={{ display:'grid', gridTemplateColumns:'380px 1fr',
        gap:'16px', marginBottom:'16px' }}>

        {/* Severity Distribution */}
        <div style={CARD_STYLE}>
          <span style={SECTION_LABEL}>Severity Distribution</span>
          {total === 0 ? (
            <EmptyChart message="No recordings yet"/>
          ) : (
            <>
              <div style={{ display:'flex', justifyContent:'center', marginBottom:'14px' }}>
                <PieChart width={200} height={200}>
                  <Pie
                    data={pieData} cx={100} cy={100}
                    innerRadius={56} outerRadius={88}
                    dataKey="value" paddingAngle={3}>
                    {pieData.map((e, i) => <Cell key={i} fill={e.color}/>)}
                  </Pie>
                  <Tooltip contentStyle={TOOLTIP_STYLE}/>
                </PieChart>
              </div>
              {pieData.map(d => (
                <div key={d.name}
                  style={{
                    display:'flex', alignItems:'center', gap:'10px',
                    padding:'8px 0',
                    borderBottom:'1px solid rgba(51,65,85,0.30)',
                    fontSize:'13px',
                  }}>
                  <div style={{
                    width:'10px', height:'10px', borderRadius:'4px',
                    background: d.color, flexShrink:0,
                    boxShadow:`0 0 8px ${d.color}55`,
                  }}/>
                  <span style={{ color:'#CBD5E1', flex:1 }}>{d.name}</span>
                  <span style={{ fontWeight:800, color:'#F1F5F9' }}>{d.value}</span>
                  <span style={{ color:'#64748B', fontSize:'11px' }}>
                    ({total > 0 ? Math.round(d.value/total*100) : 0}%)
                  </span>
                </div>
              ))}
            </>
          )}
        </div>

        {/* 7-day activity trend */}
        <div style={CARD_STYLE}>
          <span style={SECTION_LABEL}>7-Day Activity</span>
          {dailyData.every(d => d.total === 0) ? (
            <EmptyChart message="No activity in the last 7 days"/>
          ) : (
            <ResponsiveContainer width="100%" height={236}>
              <AreaChart data={dailyData} margin={{ top:10, right:10, left:-15, bottom:0 }}>
                <defs>
                  <linearGradient id="grad-total" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#60A5FA" stopOpacity={0.45}/>
                    <stop offset="95%" stopColor="#60A5FA" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="grad-crit" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#F87171" stopOpacity={0.40}/>
                    <stop offset="95%" stopColor="#F87171" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(51,65,85,0.20)" vertical={false}/>
                <XAxis dataKey="day" tick={{ fill:'#64748B', fontSize:10 }}
                  axisLine={false} tickLine={false}/>
                <YAxis tick={{ fill:'#64748B', fontSize:10 }}
                  axisLine={false} tickLine={false}/>
                <Tooltip contentStyle={TOOLTIP_STYLE}/>
                <Legend
                  wrapperStyle={{ fontSize:'11px', color:'#94A3B8' }}
                  iconType="circle" iconSize={8}/>
                <Area type="monotone" dataKey="total" name="Total"
                  stroke="#60A5FA" strokeWidth={2}
                  fill="url(#grad-total)"/>
                <Area type="monotone" dataKey="critical" name="Critical"
                  stroke="#F87171" strokeWidth={2}
                  fill="url(#grad-crit)"/>
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* ── Charts row 2: top officers + tone distribution ────────────────── */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr',
        gap:'16px', marginBottom:'16px' }}>

        {/* Top Officers by Critical */}
        <div style={CARD_STYLE}>
          <span style={SECTION_LABEL}>Top Officers by Critical Incidents</span>
          {officerData.length === 0 ? (
            <EmptyChart message="No critical incidents recorded yet"/>
          ) : (
            <ResponsiveContainer width="100%" height={236}>
              <BarChart data={officerData}
                margin={{ top:10, right:10, left:-15, bottom:0 }}>
                <CartesianGrid stroke="rgba(51,65,85,0.20)" vertical={false}/>
                <XAxis dataKey="officer" tick={{ fill:'#64748B', fontSize:10 }}
                  axisLine={false} tickLine={false}/>
                <YAxis tick={{ fill:'#64748B', fontSize:10 }}
                  axisLine={false} tickLine={false}/>
                <Tooltip contentStyle={TOOLTIP_STYLE}/>
                <Legend
                  wrapperStyle={{ fontSize:'11px', color:'#94A3B8' }}
                  iconType="circle" iconSize={8}/>
                <Bar dataKey="critical" name="Critical"
                  fill="#F87171" radius={[6,6,0,0]}/>
                <Bar dataKey="total" name="Total recordings"
                  fill="#60A5FA" radius={[6,6,0,0]}/>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* ── Officer Tone Mix — donut + legend (fleet-wide) ─────── */}
        <div style={CARD_STYLE}>
          <span style={SECTION_LABEL}>Officer Tone Mix · Fleet-Wide</span>
          {toneData.length === 0 ? (
            <EmptyChart message="Analyze recordings to see tone breakdown"/>
          ) : (
            <ToneMixWidget data={toneData} total={allItems.length}/>
          )}
        </div>
      </div>

      {/* ── Recent recordings table ──────────────────────────────────────── */}
      <div style={CARD_STYLE}>
        <div style={{ display:'flex', justifyContent:'space-between',
          alignItems:'center', marginBottom:'16px' }}>
          <span style={{ ...SECTION_LABEL, marginBottom:0 }}>Recent Recordings</span>
          <a href="#/video-analysis" style={{
            fontSize:'12px', color:'#60A5FA', textDecoration:'none',
            fontWeight:700, padding:'6px 12px', borderRadius:'8px',
            border:'1px solid rgba(96,165,250,0.30)',
            background:'rgba(96,165,250,0.08)',
            transition:'all .15s',
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(96,165,250,0.16)'}
          onMouseLeave={e => e.currentTarget.style.background = 'rgba(96,165,250,0.08)'}>
            View all →
          </a>
        </div>

        {recent.length === 0 ? (
          <div style={{ textAlign:'center', padding:'56px 0' }}>
            <div style={{ fontSize:'40px', color:'#1F2937', marginBottom:'14px' }}>⬡</div>
            <div style={{ fontSize:'14px', color:'#94A3B8', fontWeight:700, marginBottom:'8px' }}>
              No recordings yet
            </div>
            <div style={{ fontSize:'12px', color:'#64748B', lineHeight:1.7 }}>
              Drop a video into <code style={{
                background:'rgba(96,165,250,0.08)', color:'#60A5FA',
                padding:'3px 8px', borderRadius:'5px',
                fontSize:'11px',
              }}>WatchFolder/Inbox/</code> to start.
            </div>
          </div>
        ) : (
          <div>
            {/* Header row */}
            <div style={{
              display:'grid',
              gridTemplateColumns:'80px 140px 1fr 130px 110px 90px',
              gap:'12px', paddingBottom:'12px',
              borderBottom:'1px solid rgba(51,65,85,0.30)',
            }}>
              {['ID','Officer','File','Severity','Score','Time'].map(h => (
                <div key={h} style={{
                  fontSize:'10px', color:'#64748B',
                  textTransform:'uppercase', letterSpacing:'0.10em', fontWeight:800,
                }}>{h}</div>
              ))}
            </div>
            {/* Data rows */}
            {recent.map(it => {
              const sc  = it.score || 0
              const col = sc >= 70 ? '#F87171' : sc >= 30 ? '#FBBF24' : '#34D399'
              return (
                <div key={it.id} className="db-fade"
                  style={{
                    display:'grid',
                    gridTemplateColumns:'80px 140px 1fr 130px 110px 90px',
                    gap:'12px', padding:'14px 0',
                    borderBottom:'1px solid rgba(51,65,85,0.20)',
                    alignItems:'center',
                    transition:'background .15s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(51,65,85,0.10)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                  <div style={{
                    fontFamily:'ui-monospace, "SF Mono", Menlo, monospace',
                    fontSize:'11px', color:'#64748B',
                  }}>#{it.id}</div>
                  <div style={{ fontSize:'12px', color:'#F1F5F9', fontWeight:700,
                    overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                    {it.officerId}
                  </div>
                  <div style={{ fontSize:'12px', color:'#94A3B8',
                    overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                    {it.filename}
                  </div>
                  <div><SeverityBadge severity={it.severity}/></div>
                  <div>
                    <div style={{ fontSize:'17px', fontWeight:800, color: col,
                      letterSpacing:'-0.02em', marginBottom:'4px' }}>{sc}</div>
                    <ScoreBar score={sc} height={3}/>
                  </div>
                  <div style={{ fontSize:'11px', color:'#64748B' }}>
                    {formatAgo(it.uploadedAt)}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// Small helper for empty chart placeholder
function EmptyChart({ message }) {
  return (
    <div style={{
      display:'flex', alignItems:'center', justifyContent:'center',
      height:'200px', color:'#475569', fontSize:'12px',
      fontStyle:'italic',
    }}>
      {message}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────
// ToneMixWidget — animated donut + legend showing per-tone share of
// the fleet. Aggregated client-side from /api/recordings (toneLabel
// column), so it reflects whatever's currently in MSSQL.
//
// Tones surfaced: NORMAL · HARSH · ANGRY · BRIBE_TONE — these are
// the four classes the SVM tone classifier in server.py emits, plus
// the bribe-tone rule set.
// ──────────────────────────────────────────────────────────────────
const TONE_PALETTE = {
  NORMAL:     { fg:'#34D399', label:'Normal'      },
  HARSH:      { fg:'#FBBF24', label:'Harsh'       },
  ANGRY:      { fg:'#F87171', label:'Angry / Loud' },
  BRIBE_TONE: { fg:'#A78BFA', label:'Bribe-tone'  },
  LOUD:       { fg:'#FB923C', label:'Loud'        },
  UNKNOWN:    { fg:'#64748B', label:'Unknown'     },
}

function ToneMixWidget({ data, total }) {
  // Sort dominant first so the donut starts with the largest slice.
  const sorted = [...data].sort((a, b) => b.value - a.value)
  const sum = sorted.reduce((a, b) => a + b.value, 0) || 1
  const dominant = sorted[0]

  return (
    <div style={{ display:'flex', alignItems:'center', gap:'24px',
      padding:'8px 4px' }}>
      <ToneDonut slices={sorted} total={sum}
        centerLabel={dominant?.name || 'TONE'}
        centerColor={(TONE_PALETTE[dominant?.name] || TONE_PALETTE.UNKNOWN).fg}
        size={170}/>

      <div style={{ flex:1, display:'flex', flexDirection:'column', gap:'10px' }}>
        {sorted.map(s => {
          const meta = TONE_PALETTE[s.name] || TONE_PALETTE.UNKNOWN
          const pct = (s.value / sum) * 100
          return (
            <div key={s.name}>
              <div style={{ display:'flex', alignItems:'center',
                justifyContent:'space-between', marginBottom:'5px' }}>
                <span style={{ display:'flex', alignItems:'center', gap:'9px',
                  fontSize:'12px', color:'#F1F5F9', fontWeight:700 }}>
                  <span style={{ width:9, height:9, borderRadius:'3px',
                    background:meta.fg,
                    boxShadow:`0 0 8px ${meta.fg}80` }}/>
                  {meta.label}
                </span>
                <span style={{ fontSize:'12px', color:meta.fg, fontWeight:800,
                  fontVariantNumeric:'tabular-nums' }}>
                  {pct.toFixed(0)}% <span style={{
                    fontSize:'10px', color:'#64748B', fontWeight:600 }}>
                    · {s.value}</span>
                </span>
              </div>
              <div style={{ height:'4px', borderRadius:'3px',
                background:'rgba(255,255,255,0.05)', overflow:'hidden' }}>
                <div style={{ width:`${pct}%`, height:'100%',
                  background:`linear-gradient(90deg, ${meta.fg}AA, ${meta.fg})`,
                  boxShadow:`0 0 8px ${meta.fg}80`,
                  borderRadius:'3px',
                  transition:'width .6s cubic-bezier(0.4, 0, 0.2, 1)' }}/>
              </div>
            </div>
          )
        })}

        <div style={{ marginTop:'4px', fontSize:'10px', color:'#64748B',
          fontWeight:600 }}>
          Aggregated across {total} recent recordings · classifier output from
          the SVM tone model (NORMAL · HARSH · ANGRY · BRIBE_TONE).
        </div>
      </div>
    </div>
  )
}

function ToneDonut({ slices, total, size = 170, centerLabel, centerColor }) {
  const r = size / 2 - 14
  const circ = 2 * Math.PI * r
  let offset = 0

  return (
    <div style={{ position:'relative', width:size, height:size, flexShrink:0 }}>
      <svg width={size} height={size} style={{ transform:'rotate(-90deg)' }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none"
          stroke="rgba(255,255,255,0.05)" strokeWidth="16"/>
        {slices.map(s => {
          const meta = TONE_PALETTE[s.name] || TONE_PALETTE.UNKNOWN
          const len = (s.value / total) * circ
          const dash = `${len} ${circ - len}`
          const o = -offset
          offset += len
          return (
            <circle key={s.name} cx={size/2} cy={size/2} r={r} fill="none"
              stroke={meta.fg} strokeWidth="16"
              strokeDasharray={dash} strokeDashoffset={o}
              strokeLinecap="butt"
              style={{ transition:'all .6s cubic-bezier(0.4, 0, 0.2, 1)',
                filter:`drop-shadow(0 0 6px ${meta.fg}80)` }}/>
          )
        })}
      </svg>
      <div style={{ position:'absolute', inset:0, display:'flex',
        flexDirection:'column', alignItems:'center', justifyContent:'center' }}>
        <div style={{ fontSize:'10px', color:'#64748B', fontWeight:800,
          letterSpacing:'0.10em', textTransform:'uppercase' }}>
          Dominant
        </div>
        <div style={{ fontSize:'15px', fontWeight:900,
          color: centerColor || '#F1F5F9', letterSpacing:'-0.01em',
          marginTop:'4px' }}>
          {centerLabel}
        </div>
      </div>
    </div>
  )
}
