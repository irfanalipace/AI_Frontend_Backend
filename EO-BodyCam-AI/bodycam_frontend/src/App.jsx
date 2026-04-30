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
import ApiService    from './services/api'

const NAV = [
  { to:'/',          label:'Dashboard',       icon:'◧' },
  { to:'/upload',    label:'Upload Audio',    icon:'↑' },
  { to:'/gemini',    label:'Gemini Analysis', icon:'✦' },
  { to:'/video-analysis', label:'Video Analysis', icon:'▶' },
  { to:'/live',      label:'Live Stream',     icon:'●', live:true },
  { to:'/samples',   label:'Test Samples',    icon:'▦' },
  { to:'/incidents', label:'Incidents',       icon:'⚑' },
  { to:'/officers',  label:'Officers',        icon:'◎' },
]

export default function App() {
  const { connected, alerts, markRead, clearAlerts, liveStatus } = useSocket()
  const [info, setInfo] = useState(null)
  const unread = alerts.filter(a => !a.read).length
  const latest = alerts[0]

  useEffect(() => {
    ApiService.health().then(r => setInfo(r.data)).catch(() => {})
  }, [])

  return (
    <BrowserRouter>
      <div style={{ display:'flex', minHeight:'100vh', background:'#0B0F1A' }}>

        {/* Sidebar */}
        <aside style={{ width:240, flexShrink:0, background:'#111827',
          borderRight:'1px solid #1F2937', display:'flex',
          flexDirection:'column', height:'100vh', position:'sticky', top:0 }}>

          {/* Logo */}
          <div style={{ padding:'22px 20px 18px', borderBottom:'1px solid #1F2937' }}>
            <div style={{ display:'flex', alignItems:'center', gap:'12px', marginBottom:'16px' }}>
              <div style={{ width:40, height:40,
                background:'linear-gradient(135deg, #3B82F6, #6366F1)',
                borderRadius:'12px', display:'flex', alignItems:'center',
                justifyContent:'center', fontSize:'14px', fontWeight:900, color:'#fff',
                boxShadow:'0 4px 12px rgba(59,130,246,0.3)' }}>
                EO
              </div>
              <div>
                <div style={{ fontSize:'15px', fontWeight:800, color:'#F1F5F9',
                  letterSpacing:'-0.02em' }}>Bodycam AI</div>
                <div style={{ fontSize:'10px', color:'#64748B', letterSpacing:'0.08em',
                  textTransform:'uppercase', fontWeight:600 }}>
                  Violation Detection
                </div>
              </div>
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:'8px', fontSize:'11px', marginBottom:'6px' }}>
              <div style={{ width:8, height:8, borderRadius:'50%',
                background: connected ? '#10B981' : '#EF4444',
                boxShadow: connected ? '0 0 8px rgba(16,185,129,0.5)' : '0 0 8px rgba(239,68,68,0.5)',
                animation: connected ? 'none' : 'pulse 1.5s infinite' }}/>
              <span style={{ color: connected ? '#10B981' : '#EF4444', fontWeight:600 }}>
                {connected ? 'System Online' : 'System Offline'}
              </span>
            </div>
            {info && (
              <div style={{ fontSize:'10px', color:'#475569', lineHeight:1.7 }}>
                Whisper: {info.whisper_available ? '✓ Active' : '○ Offline'} · SVM {info.tone_cv_acc}%
              </div>
            )}
          </div>

          {/* Nav */}
          <nav style={{ flex:1, padding:'12px', overflowY:'auto' }}>
            {NAV.map(item => (
              <NavLink key={item.to} to={item.to}
                style={({ isActive }) => ({
                  display:'flex', alignItems:'center', gap:'12px',
                  padding:'10px 14px', borderRadius:'10px', marginBottom:'3px',
                  textDecoration:'none', fontSize:'13px',
                  fontWeight: isActive ? 700 : 500,
                  background: isActive ? 'rgba(59,130,246,0.12)' : 'transparent',
                  color: isActive ? '#3B82F6' : '#94A3B8',
                  borderLeft: isActive ? '3px solid #3B82F6' : '3px solid transparent',
                  transition:'all .2s',
                })}>
                <span style={{ color: item.live ? '#EF4444' : 'inherit',
                  animation: item.live ? 'liveGlow 2s infinite' : 'none',
                  fontSize:'14px', width:'18px', textAlign:'center' }}>
                  {item.icon}
                </span>
                <span style={{ flex:1 }}>{item.label}</span>
                {item.label === 'Incidents' && unread > 0 && (
                  <span style={{ background:'linear-gradient(135deg, #EF4444, #DC2626)',
                    color:'#fff', fontSize:'10px', fontWeight:700,
                    padding:'2px 7px', borderRadius:'10px',
                    boxShadow:'0 2px 6px rgba(239,68,68,0.3)' }}>{unread}</span>
                )}
              </NavLink>
            ))}
          </nav>

          {/* Latest alert */}
          {latest && (
            <div style={{ margin:'12px', padding:'12px 14px', borderRadius:'12px', fontSize:'11px',
              background: latest.severity === 'CRITICAL'
                ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.1)',
              border: `1px solid ${latest.severity === 'CRITICAL'
                ? 'rgba(239,68,68,0.25)' : 'rgba(245,158,11,0.25)'}`,
              boxShadow: latest.severity === 'CRITICAL'
                ? '0 0 16px rgba(239,68,68,0.1)' : 'none' }}>
              <div style={{ fontWeight:700, fontSize:'10px', letterSpacing:'0.06em',
                color: latest.severity === 'CRITICAL' ? '#EF4444' : '#F59E0B',
                marginBottom:'4px', textTransform:'uppercase' }}>Latest Alert</div>
              <div style={{ color:'#F1F5F9', fontWeight:700 }}>
                {latest.officer_id} — {latest.total_score}/100
              </div>
              <div style={{ color:'#64748B', fontSize:'10px', marginTop:'3px' }}>
                {latest.violations?.length} violations · {latest.severity}
              </div>
            </div>
          )}

          <div style={{ padding:'14px 20px', borderTop:'1px solid #1F2937',
            fontSize:'10px', color:'#475569', letterSpacing:'0.05em' }}>
            v5.0 · 588 Keywords · 10 Categories
          </div>
        </aside>

        {/* Main */}
        <main style={{ flex:1, overflow:'auto', background:'#0B0F1A' }}>
          <Routes>
            <Route path="/"          element={<Dashboard />} />
            <Route path="/upload"    element={<Upload />} />
            <Route path="/gemini"    element={<GeminiAnalyse />} />
            <Route path="/video-analysis" element={<VideoAnalysis />} />
            <Route path="/live"      element={<LiveStream liveStatus={liveStatus} />} />
            <Route path="/samples"   element={<Samples />} />
            <Route path="/incidents" element={<Incidents alerts={alerts} markRead={markRead} clearAlerts={clearAlerts} />} />
            <Route path="/officers"  element={<Officers />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}
