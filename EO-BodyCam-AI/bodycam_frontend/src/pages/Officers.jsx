import React, { useState, useEffect, useRef, useMemo } from 'react'
import ApiService from '../services/api'

// Premium dark theme tokens — matches Dashboard / Incidents.
const SURFACE = 'rgba(255,255,255,0.02)'
const BORDER  = '#1F2937'

const initials = (name = '') =>
  name.split(/[\s_-]+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?'

// Deterministic gradient per officer so each card has its own identity.
const avatarGradient = (id = '') => {
  const palettes = [
    ['#3B82F6', '#6366F1'],
    ['#8B5CF6', '#EC4899'],
    ['#10B981', '#14B8A6'],
    ['#F59E0B', '#EF4444'],
    ['#06B6D4', '#3B82F6'],
    ['#F97316', '#F59E0B'],
  ]
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  const [a, b] = palettes[h % palettes.length]
  return `linear-gradient(135deg, ${a}, ${b})`
}

export default function Officers() {
  const [officers,  setOfficers]  = useState([])
  const [stats,     setStats]     = useState(null)
  const [loading,   setLoading]   = useState(true)
  const [err,       setErr]       = useState(null)

  const [form,      setForm]      = useState({ id:'', name:'', area:'' })
  const [audioFile, setAudio]     = useState(null)
  const [enrolling, setEnrolling] = useState(false)
  const [msg,       setMsg]       = useState(null)
  const fileRef = useRef()

  // ── Load officers + stats from .NET (live MSSQL) ────────────────
  const load = async () => {
    setLoading(true); setErr(null)
    try {
      const [o, s] = await Promise.all([
        ApiService.dotnetOfficers(),
        ApiService.dotnetRecordingStats(),
      ])
      setOfficers(Array.isArray(o.data) ? o.data : (o.data.officers || []))
      setStats(s.data)
    } catch {
      setErr('Cannot reach .NET backend on :8080. Live officer data is unavailable.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  // Map officerId → criticalCount from stats (top officers list).
  const criticalById = useMemo(() => {
    const m = {}
    if (stats?.topOfficersByCritical) {
      stats.topOfficersByCritical.forEach(x => { m[x.officerId] = x.criticalCount })
    }
    return m
  }, [stats])

  const totalRecs   = officers.reduce((a, o) => a + (o.recordings || 0), 0)
  const enrolledCnt = officers.filter(o => o.enrolled).length

  const enroll = async () => {
    setMsg(null)
    if (!form.id.trim())   return setMsg({ type:'error', text:'Officer ID is required (e.g. EO_004)' })
    if (!form.name.trim()) return setMsg({ type:'error', text:'Full name is required' })
    if (!audioFile)        return setMsg({ type:'error', text:'Please select an audio file (WAV/MP3)' })

    setEnrolling(true)
    setMsg({ type:'info', text:'Enrolling — extracting voiceprint, please wait...' })
    try {
      const r = await ApiService.enrollOfficer(
        form.id.trim(), form.name.trim(), form.area.trim(), audioFile,
      )
      setMsg({
        type:'success',
        text:`✓ ${r.data.name} enrolled · pitch ${r.data.pitch_hz}Hz · ${r.data.windows || ''} windows`,
      })
      setForm({ id:'', name:'', area:'' })
      setAudio(null)
      if (fileRef.current) fileRef.current.value = ''
      load()
    } catch (e) {
      let t = 'Enrollment failed'
      if (e.code === 'ECONNABORTED')      t = 'Request timed out — try a shorter clip'
      else if (e.response?.data?.error)   t = e.response.data.error
      else if (e.message)                 t = e.message
      setMsg({ type:'error', text:t })
    } finally {
      setEnrolling(false)
    }
  }

  // ── Inline message styles ──────────────────────────────────────
  const msgStyle = {
    info:    { bg:'rgba(59,130,246,0.10)', border:'rgba(59,130,246,0.30)', color:'#3B82F6' },
    success: { bg:'rgba(16,185,129,0.10)', border:'rgba(16,185,129,0.30)', color:'#10B981' },
    error:   { bg:'rgba(239,68,68,0.10)',  border:'rgba(239,68,68,0.30)',  color:'#EF4444' },
  }[msg?.type] || {}

  return (
    <div style={{ padding:'32px 36px', minHeight:'100vh', color:'#F1F5F9' }}>

      {/* ── Header ────────────────────────────────────────────── */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
        marginBottom:'28px', gap:'18px', flexWrap:'wrap' }}>
        <div style={{ display:'flex', alignItems:'center', gap:'14px' }}>
          <div style={{ width:42, height:42, borderRadius:'12px',
            background:'linear-gradient(135deg, #3B82F6, #6366F1)',
            display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:'20px', fontWeight:900, color:'#fff',
            boxShadow:'0 8px 20px rgba(59,130,246,0.35)' }}>◎</div>
          <div>
            <h1 style={{ fontSize:'26px', fontWeight:800, margin:0,
              letterSpacing:'-0.02em', color:'#F1F5F9' }}>Officers</h1>
            <div style={{ fontSize:'12px', color:'#64748B', marginTop:'2px' }}>
              Live MSSQL · voice enrollments &amp; per-officer monitoring
            </div>
          </div>
        </div>

        <button onClick={load}
          style={{ fontSize:'11px', color:'#3B82F6', background:'rgba(59,130,246,0.08)',
            border:'1px solid rgba(59,130,246,0.25)', padding:'7px 14px',
            borderRadius:'8px', cursor:'pointer', fontWeight:700 }}>↻ Refresh</button>
      </div>

      {/* ── KPI tiles ─────────────────────────────────────────── */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)',
        gap:'14px', marginBottom:'24px' }}>
        {[
          { lbl:'Total Officers', val: officers.length,                color:'#3B82F6', accent:'rgba(59,130,246,0.15)' },
          { lbl:'Voice-Enrolled', val: enrolledCnt,                    color:'#10B981', accent:'rgba(16,185,129,0.15)' },
          { lbl:'Total Recordings', val: totalRecs,                    color:'#8B5CF6', accent:'rgba(139,92,246,0.15)' },
          { lbl:'Critical Incidents', val: stats?.critical ?? 0,       color:'#EF4444', accent:'rgba(239,68,68,0.15)' },
        ].map(k => (
          <div key={k.lbl} style={{ padding:'18px 20px', borderRadius:'14px',
            background:`linear-gradient(135deg, ${k.accent}, ${SURFACE})`,
            border:`1px solid ${BORDER}` }}>
            <div style={{ fontSize:'10px', color:'#64748B', fontWeight:700,
              letterSpacing:'0.08em', textTransform:'uppercase' }}>{k.lbl}</div>
            <div style={{ fontSize:'28px', fontWeight:800, color:k.color,
              marginTop:'8px', letterSpacing:'-0.02em' }}>{k.val}</div>
          </div>
        ))}
      </div>

      {err && (
        <div style={{ padding:'14px 18px', marginBottom:'18px', borderRadius:'12px',
          background:'rgba(239,68,68,0.06)', border:'1px solid rgba(239,68,68,0.25)',
          color:'#EF4444', fontSize:'12px' }}>{err}</div>
      )}

      {/* ── Two-column: officer list | enrollment form ─────────── */}
      <div style={{ display:'grid', gridTemplateColumns:'1.4fr 1fr', gap:'18px' }}>

        {/* ── Officer list ──────────────────────────────────── */}
        <div style={{ padding:'20px', borderRadius:'14px',
          background:SURFACE, border:`1px solid ${BORDER}` }}>
          <div style={{ display:'flex', justifyContent:'space-between',
            alignItems:'center', marginBottom:'14px' }}>
            <div style={{ fontSize:'10px', color:'#64748B', fontWeight:700,
              letterSpacing:'0.08em', textTransform:'uppercase' }}>
              Enrolled Officers
            </div>
            <span style={{ fontSize:'10px', color:'#94A3B8' }}>
              {officers.length} total · {enrolledCnt} voiceprinted
            </span>
          </div>

          {loading ? (
            <div style={{ padding:'40px', textAlign:'center',
              color:'#64748B', fontSize:'12px' }}>Loading from MSSQL...</div>
          ) : officers.length === 0 ? (
            <div style={{ padding:'30px', textAlign:'center',
              color:'#64748B', fontSize:'13px' }}>
              No officers in the database yet.
            </div>
          ) : (
            officers
              .slice()
              .sort((a, b) => (b.recordings || 0) - (a.recordings || 0))
              .map(o => {
                const crit = criticalById[o.id] || 0
                return (
                  <div key={o.id} style={{ display:'flex', alignItems:'center',
                    gap:'14px', padding:'14px 16px', marginBottom:'10px',
                    borderRadius:'12px', background:'rgba(255,255,255,0.025)',
                    border:`1px solid ${BORDER}`, transition:'all .2s' }}>

                    {/* Avatar */}
                    <div style={{ width:46, height:46, borderRadius:'12px',
                      flexShrink:0, background:avatarGradient(o.id),
                      display:'flex', alignItems:'center', justifyContent:'center',
                      fontSize:'14px', fontWeight:800, color:'#fff',
                      boxShadow:'0 6px 14px rgba(0,0,0,0.35)' }}>
                      {initials(o.name || o.id)}
                    </div>

                    {/* Identity */}
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:'13px', fontWeight:700,
                        color:'#F1F5F9', marginBottom:'3px' }}>{o.name || o.id}</div>
                      <div style={{ fontSize:'11px', color:'#64748B' }}>
                        ID {o.id}{o.badge && o.badge !== o.id ? ` · #${o.badge}` : ''}
                        {o.area ? ` · ${o.area}` : ''}
                      </div>
                    </div>

                    {/* Per-officer activity */}
                    <div style={{ display:'flex', gap:'8px', alignItems:'center',
                      flexShrink:0 }}>
                      <span title="Total recordings"
                        style={{ fontSize:'11px', fontWeight:700, padding:'5px 10px',
                          borderRadius:'8px', color:'#3B82F6',
                          background:'rgba(59,130,246,0.10)',
                          border:'1px solid rgba(59,130,246,0.25)' }}>
                        {o.recordings || 0} recs
                      </span>
                      {crit > 0 && (
                        <span title="Critical incidents"
                          style={{ fontSize:'11px', fontWeight:800, padding:'5px 10px',
                            borderRadius:'8px', color:'#EF4444',
                            background:'rgba(239,68,68,0.10)',
                            border:'1px solid rgba(239,68,68,0.30)' }}>
                          {crit} CRITICAL
                        </span>
                      )}
                      <span style={{ fontSize:'10px', fontWeight:700,
                        padding:'5px 10px', borderRadius:'8px', whiteSpace:'nowrap',
                        color: o.enrolled ? '#10B981' : '#64748B',
                        background: o.enrolled
                          ? 'rgba(16,185,129,0.10)' : 'rgba(255,255,255,0.03)',
                        border:`1px solid ${o.enrolled
                          ? 'rgba(16,185,129,0.30)' : BORDER}` }}>
                        {o.enrolled ? '✓ Enrolled' : 'No voiceprint'}
                      </span>
                    </div>
                  </div>
                )
              })
          )}
        </div>

        {/* ── Enrollment form ───────────────────────────────────── */}
        <div style={{ padding:'20px', borderRadius:'14px',
          background:SURFACE, border:`1px solid ${BORDER}` }}>

          <div style={{ display:'flex', alignItems:'center', gap:'10px',
            marginBottom:'14px' }}>
            <div style={{ width:32, height:32, borderRadius:'8px',
              background:'linear-gradient(135deg, #10B981, #14B8A6)',
              display:'flex', alignItems:'center', justifyContent:'center',
              color:'#fff', fontSize:'14px', fontWeight:900 }}>+</div>
            <div>
              <div style={{ fontSize:'14px', fontWeight:800, color:'#F1F5F9' }}>
                Enroll New Officer
              </div>
              <div style={{ fontSize:'10px', color:'#64748B' }}>
                Build a 106-D MFCC voiceprint from a 10–30s sample
              </div>
            </div>
          </div>

          <div style={{ display:'flex', flexDirection:'column', gap:'14px' }}>

            <Field label="Officer ID" hint="e.g. EO_004"
              value={form.id}
              onChange={v => { setForm(p => ({ ...p, id: v })); setMsg(null) }}/>

            <Field label="Full Name" hint="e.g. Muhammad Bilal"
              value={form.name}
              onChange={v => { setForm(p => ({ ...p, name: v })); setMsg(null) }}/>

            <Field label="Area / Zone" hint="optional · e.g. Lahore - Gulberg"
              value={form.area}
              onChange={v => setForm(p => ({ ...p, area: v }))}/>

            {/* File picker */}
            <div>
              <label style={labelStyle}>Enrollment Audio
                <span style={hintStyle}>10–30 sec of officer speaking</span>
              </label>
              <div onClick={() => !enrolling && fileRef.current.click()}
                style={{ border:`1px dashed ${audioFile
                  ? 'rgba(16,185,129,0.5)' : BORDER}`,
                  borderRadius:'10px', padding:'18px', textAlign:'center',
                  cursor: enrolling ? 'not-allowed' : 'pointer',
                  background: audioFile
                    ? 'rgba(16,185,129,0.06)' : 'rgba(255,255,255,0.02)',
                  transition:'all .2s' }}>
                <input ref={fileRef} type="file"
                  accept=".wav,.mp3,.m4a,.ogg,.webm"
                  style={{ display:'none' }}
                  onChange={e => {
                    if (e.target.files[0]) { setAudio(e.target.files[0]); setMsg(null) }
                  }}/>
                {audioFile ? (
                  <>
                    <div style={{ fontSize:'20px', color:'#10B981',
                      marginBottom:'4px' }}>✓</div>
                    <div style={{ fontSize:'12px', color:'#10B981',
                      fontWeight:700 }}>{audioFile.name}</div>
                    <div style={{ fontSize:'10px', color:'#64748B', marginTop:'3px' }}>
                      {(audioFile.size / 1024).toFixed(0)} KB · click to change
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize:'22px', color:'#475569',
                      marginBottom:'4px' }}>↑</div>
                    <div style={{ fontSize:'12px', color:'#94A3B8' }}>
                      Click to select WAV / MP3 / M4A
                    </div>
                    <div style={{ fontSize:'10px', color:'#64748B', marginTop:'3px' }}>
                      WhatsApp voice note or any audio recording works
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Inline message */}
            {msg && (
              <div style={{ background:msgStyle.bg,
                border:`1px solid ${msgStyle.border}`,
                color:msgStyle.color, fontSize:'12px',
                padding:'10px 12px', borderRadius:'8px', lineHeight:1.5 }}>
                {msg.text}
              </div>
            )}

            <button onClick={enroll} disabled={enrolling}
              style={{ padding:'13px', fontSize:'13px', fontWeight:800,
                borderRadius:'10px', cursor: enrolling ? 'not-allowed' : 'pointer',
                color:'#fff', border:'none',
                background: enrolling
                  ? 'rgba(255,255,255,0.08)'
                  : 'linear-gradient(135deg, #3B82F6, #6366F1)',
                boxShadow: enrolling
                  ? 'none' : '0 8px 20px rgba(59,130,246,0.30)',
                transition:'all .2s' }}>
              {enrolling ? 'Building voiceprint...' : '◎  Enroll Officer'}
            </button>
          </div>
        </div>
      </div>

      {/* ── How it works panel ───────────────────────────────────── */}
      <div style={{ marginTop:'18px', padding:'16px 20px', borderRadius:'12px',
        background:SURFACE, border:`1px solid ${BORDER}`,
        fontSize:'11px', color:'#94A3B8', lineHeight:1.7 }}>
        <div style={{ fontSize:'10px', color:'#64748B', fontWeight:700,
          letterSpacing:'0.08em', textTransform:'uppercase', marginBottom:'8px' }}>
          How Voice Enrollment Works
        </div>
        The system extracts a <strong style={{ color:'#F1F5F9' }}>106-dimensional MFCC voiceprint</strong> from
        the audio — capturing this officer's pitch, rhythm and frequency signature.
        During bodycam analysis, every 2-second window is matched against this fingerprint;
        segments above <strong style={{ color:'#F1F5F9' }}>0.82 cosine similarity</strong> are
        attributed to this officer and analysed for tone (HARSH / ANGRY / LOUD / NORMAL),
        abusive keywords (RISHWAT, DHAMKI, GALI, POWER_ABUSE, …) and overall conduct.
      </div>
    </div>
  )
}

// ── Tiny field primitive ────────────────────────────────────────
const labelStyle = { display:'block', fontSize:'10px', color:'#94A3B8',
  fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase',
  marginBottom:'7px' }
const hintStyle = { fontWeight:400, textTransform:'none', letterSpacing:0,
  marginLeft:'8px', color:'#64748B' }

function Field({ label, hint, value, onChange }) {
  return (
    <div>
      <label style={labelStyle}>{label}{hint && <span style={hintStyle}>{hint}</span>}</label>
      <input value={value} onChange={e => onChange(e.target.value)}
        placeholder={hint?.replace(/^.*?· /, '') || ''}
        style={{ width:'100%', padding:'10px 14px', fontSize:'13px',
          background:'rgba(0,0,0,0.25)', color:'#F1F5F9',
          border:`1px solid ${BORDER}`, borderRadius:'10px',
          outline:'none', transition:'border .2s' }}
        onFocus={e => e.target.style.borderColor = 'rgba(59,130,246,0.4)'}
        onBlur={e => e.target.style.borderColor = BORDER}/>
    </div>
  )
}
