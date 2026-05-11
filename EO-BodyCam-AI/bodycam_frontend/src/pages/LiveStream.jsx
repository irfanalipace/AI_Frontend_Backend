import React, { useState, useRef, useEffect, useMemo } from 'react'
import ApiService          from '../services/api'
import IncidentDetailModal from '../components/IncidentDetailModal'

/**
 * LiveStream — real-time bodycam audio analysis.
 *
 *   • Captures mic audio in 5-second chunks → POSTs to Python /api/livestream/chunk
 *   • Each chunk gets: tone classification, keyword scan, severity, violations
 *   • UI shows: live score ring, audio level meter, KPI tiles, chunk history
 *   • Sticky CRITICAL banner when a chunk lands in CRITICAL severity
 *
 * Pure presentation + transport — does NOT change analysis logic.
 */

const SEV = {
  CRITICAL: { color:'#EF4444', bg:'rgba(239,68,68,0.10)',  border:'rgba(239,68,68,0.30)',  glow:'0 0 24px rgba(239,68,68,0.20)' },
  WARNING:  { color:'#F59E0B', bg:'rgba(245,158,11,0.10)', border:'rgba(245,158,11,0.30)', glow:'0 0 24px rgba(245,158,11,0.15)' },
  NORMAL:   { color:'#10B981', bg:'rgba(16,185,129,0.10)', border:'rgba(16,185,129,0.30)', glow:'0 0 16px rgba(16,185,129,0.10)' },
}

const TONE_COLOR = {
  NORMAL:'#10B981', HARSH:'#F59E0B', ANGRY:'#EF4444',
  BRIBE_TONE:'#8B5CF6', LOUD:'#F59E0B', UNKNOWN:'#64748B',
}

const fmtElapsed = (ms) => {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const ss = String(s % 60).padStart(2, '0')
  const mm = String(m).padStart(2, '0')
  return `${mm}:${ss}`
}

export default function LiveStream({ liveStatus }) {
  const [streaming,   setStreaming]   = useState(false)
  const [officers,    setOfficers]    = useState([])
  const [officerId,   setOfficerId]   = useState('EO000')
  const [sessionId]                   = useState(() => `LIVE_${Date.now()}`)
  const [chunkIdx,    setChunkIdx]    = useState(0)
  const [results,     setResults]     = useState([])
  const [current,     setCurrent]     = useState(null)
  const [error,       setError]       = useState(null)
  const [audioLevel,  setAudioLevel]  = useState(0)
  const [elapsedMs,   setElapsedMs]   = useState(0)

  const mediaRef     = useRef(null)
  const recRef       = useRef(null)
  const chunkRef     = useRef(0)
  const scrollRef    = useRef(null)
  const audioCtxRef  = useRef(null)
  const analyserRef  = useRef(null)
  const rafRef       = useRef(null)
  const startedAtRef = useRef(0)
  const timerRef     = useRef(null)

  // ── Load officers (live from MSSQL) ─────────────────────────────
  useEffect(() => {
    ApiService.dotnetOfficers()
      .then(r => {
        const list = Array.isArray(r.data) ? r.data : (r.data?.officers || [])
        setOfficers(list)
        if (list.length > 0 && !list.find(o => o.id === officerId)) {
          setOfficerId(list[0].id)
        }
      })
      .catch(() => {
        // Fallback to a minimal default if .NET is unreachable
        setOfficers([{ id:'EO000', name:'EO000', badge:'EO000' }])
      })
  }, []) // eslint-disable-line

  // ── Auto-scroll chunk history when new entry lands ──────────────
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [results])

  // ── Session elapsed-time timer ──────────────────────────────────
  useEffect(() => {
    if (!streaming) { clearInterval(timerRef.current); return }
    startedAtRef.current = Date.now()
    timerRef.current = setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current)
    }, 250)
    return () => clearInterval(timerRef.current)
  }, [streaming])

  // ── Web Audio level meter (visual feedback) ─────────────────────
  const startLevelMeter = (stream) => {
    try {
      const ctx = audioCtxRef.current ||
        (audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)())
      const src = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      src.connect(analyser)
      analyserRef.current = analyser
      const data = new Uint8Array(analyser.frequencyBinCount)
      const tick = () => {
        if (!analyserRef.current) return
        analyserRef.current.getByteFrequencyData(data)
        const avg = data.reduce((a, b) => a + b, 0) / data.length
        setAudioLevel(Math.min(100, (avg / 255) * 100 * 1.8))
        rafRef.current = requestAnimationFrame(tick)
      }
      tick()
    } catch (e) {
      console.warn('Audio meter unavailable', e)
    }
  }
  const stopLevelMeter = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    analyserRef.current = null
    setAudioLevel(0)
  }

  // ── Start / stop ────────────────────────────────────────────────
  const startStream = async () => {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaRef.current = stream
      chunkRef.current = 0
      setChunkIdx(0); setResults([]); setCurrent(null); setElapsedMs(0)
      startLevelMeter(stream)

      const mime = MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm' : 'audio/ogg'
      const rec  = new MediaRecorder(stream, { mimeType: mime })
      recRef.current = rec

      rec.ondataavailable = async e => {
        if (e.data.size < 500) return
        const idx = chunkRef.current++
        setChunkIdx(idx + 1)
        try {
          const r = await ApiService.sendChunk(e.data, officerId, sessionId, idx)
          r.data._chunk    = idx
          r.data._receivedAt = Date.now()
          setCurrent(r.data)
          setResults(p => [...p.slice(-49), r.data])
        } catch (err) {
          console.error('chunk error', err)
        }
      }
      rec.start(5000)
      setStreaming(true)
    } catch (e) {
      setError(`Microphone error: ${e.message}`)
    }
  }

  const stopStream = () => {
    recRef.current?.stop()
    mediaRef.current?.getTracks().forEach(t => t.stop())
    stopLevelMeter()
    setStreaming(false)
  }

  // ── Derived KPIs ────────────────────────────────────────────────
  const kpis = useMemo(() => ({
    critical: results.filter(r => r.severity === 'CRITICAL').length,
    warning:  results.filter(r => r.severity === 'WARNING').length,
    normal:   results.filter(r => r.severity === 'NORMAL').length,
    avgScore: results.length === 0 ? 0
      : Math.round(results.reduce((s, r) => s + (r.total_score || 0), 0) / results.length),
    avgEoSec: results.length === 0 ? 0
      : Math.round(results.reduce((s, r) => s + (r.eo_speaking_sec || 0), 0) / results.length),
  }), [results])

  // Latest CRITICAL chunk (for sticky banner)
  const latestCritical = useMemo(
    () => [...results].reverse().find(r => r.severity === 'CRITICAL'),
    [results],
  )

  return (
    <div style={{ padding:'28px 32px', minHeight:'100vh', color:'#F1F5F9' }}>

      {/* ── Sticky CRITICAL banner ───────────────────────────── */}
      {latestCritical && (
        <div style={{ position:'sticky', top:0, zIndex:50, marginBottom:'16px',
          padding:'12px 18px', borderRadius:'12px',
          background:'linear-gradient(90deg, rgba(239,68,68,0.18), rgba(220,38,38,0.10))',
          border:'1px solid rgba(239,68,68,0.45)',
          boxShadow:'0 0 32px rgba(239,68,68,0.25)',
          display:'flex', alignItems:'center', gap:'14px',
          animation:'pulseAlert 2s ease-in-out infinite' }}>
          <span style={{ fontSize:'24px' }}>🚨</span>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:'13px', fontWeight:900, color:'#FCA5A5',
              letterSpacing:'0.06em', textTransform:'uppercase' }}>
              CRITICAL chunk detected · score {latestCritical.total_score}/100
            </div>
            <div style={{ fontSize:'11px', color:'#FECACA', marginTop:'2px' }}>
              {latestCritical.tone_label} ·{' '}
              {latestCritical.violations?.length || 0} violations ·{' '}
              chunk #{(latestCritical._chunk || 0) + 1}
            </div>
          </div>
        </div>
      )}

      {/* ── Header ─────────────────────────────────────────────── */}
      <div style={{ display:'flex', alignItems:'flex-end',
        justifyContent:'space-between', marginBottom:'22px',
        gap:'16px', flexWrap:'wrap' }}>
        <div style={{ display:'flex', alignItems:'center', gap:'12px' }}>
          <div style={{ width:42, height:42, borderRadius:'12px',
            background: streaming
              ? 'linear-gradient(135deg, #EF4444, #DC2626)'
              : 'linear-gradient(135deg, #3B82F6, #6366F1)',
            display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:'18px', color:'#fff', fontWeight:900,
            boxShadow: streaming
              ? '0 8px 20px rgba(239,68,68,0.40)'
              : '0 8px 20px rgba(59,130,246,0.30)',
            animation: streaming ? 'liveDot 1.2s infinite' : 'none' }}>●</div>
          <div>
            <h1 style={{ fontSize:'26px', fontWeight:800, margin:0,
              letterSpacing:'-0.02em', color:'#F1F5F9' }}>
              Live Stream Detection
            </h1>
            <div style={{ fontSize:'12px', color:'#64748B', marginTop:'2px' }}>
              Real-time bodycam audio · 5-sec chunks · Python ML pipeline
            </div>
          </div>
        </div>

        {streaming && (
          <div style={{ display:'flex', alignItems:'center', gap:'14px',
            flexWrap:'wrap' }}>
            <Pill color="#EF4444" pulse>● LIVE</Pill>
            <Pill color="#3B82F6">⏱ {fmtElapsed(elapsedMs)}</Pill>
            <Pill color="#94A3B8">{chunkIdx} chunks</Pill>
          </div>
        )}
      </div>

      {/* ── KPI tiles ──────────────────────────────────────────── */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(5, 1fr)',
        gap:'12px', marginBottom:'18px' }}>
        <KpiTile label="Critical"  val={kpis.critical} color="#EF4444"/>
        <KpiTile label="Warning"   val={kpis.warning}  color="#F59E0B"/>
        <KpiTile label="Normal"    val={kpis.normal}   color="#10B981"/>
        <KpiTile label="Avg Score" val={kpis.avgScore} color="#A78BFA" suffix="/100"/>
        <KpiTile label="EO On-Mic" val={kpis.avgEoSec} color="#3B82F6" suffix="s"/>
      </div>

      {/* ── Main 2-col layout ──────────────────────────────────── */}
      <div style={{ display:'grid', gridTemplateColumns:'340px 1fr',
        gap:'16px', alignItems:'start' }}>

        {/* ── LEFT COL — Controls ───────────────────────────── */}
        <div>
          <Card title="Stream Setup">
            <Label>Officer</Label>
            <select value={officerId}
              onChange={e => setOfficerId(e.target.value)}
              disabled={streaming}
              style={selectStyle}>
              {officers.map(o => (
                <option key={o.id} value={o.id}>
                  {o.name || o.id}{o.badge && o.badge !== o.id ? ` — ${o.badge}` : ''}
                </option>
              ))}
            </select>

            <div style={{ marginTop:'14px' }}>
              <Label>Session ID</Label>
              <div style={{ fontFamily:'ui-monospace, monospace', fontSize:'11px',
                color:'#94A3B8', background:'rgba(0,0,0,0.30)',
                padding:'8px 12px', borderRadius:'8px',
                border:'1px solid #1F2937', wordBreak:'break-all' }}>
                {sessionId}
              </div>
            </div>

            {/* Audio level meter — visual feedback that mic is working */}
            {streaming && (
              <div style={{ marginTop:'16px' }}>
                <div style={{ display:'flex', justifyContent:'space-between',
                  marginBottom:'5px' }}>
                  <span style={labelStyle}>Microphone Level</span>
                  <span style={{ fontSize:'10px', color:audioLevel > 30 ? '#10B981' : '#64748B',
                    fontWeight:700 }}>
                    {audioLevel > 30 ? 'GOOD' : audioLevel > 5 ? 'low' : 'silent'}
                  </span>
                </div>
                <div style={{ height:'10px', background:'rgba(255,255,255,0.05)',
                  borderRadius:'5px', overflow:'hidden', position:'relative' }}>
                  <div style={{
                    width:`${audioLevel}%`,
                    height:'100%',
                    background: audioLevel > 80 ? '#EF4444'
                              : audioLevel > 50 ? '#F59E0B'
                              : '#10B981',
                    boxShadow: `0 0 12px ${audioLevel > 80 ? '#EF4444'
                                          : audioLevel > 50 ? '#F59E0B'
                                          : '#10B981'}AA`,
                    transition:'width 60ms linear' }}/>
                </div>
              </div>
            )}
          </Card>

          <div style={{ marginBottom:'14px' }}>
            {!streaming ? (
              <button onClick={startStream} style={startBtnStyle}>
                <span style={{ fontSize:'14px' }}>●</span>
                <span>Start Live Recording</span>
              </button>
            ) : (
              <button onClick={stopStream} style={stopBtnStyle}>
                <span>■</span>
                <span>Stop Recording</span>
              </button>
            )}
          </div>

          <Card title="Mobile as Body Cam">
            <ul style={{ margin:0, padding:'0 0 0 18px', fontSize:'12px',
              color:'#94A3B8', lineHeight:1.85 }}>
              <li>Install <strong style={{ color:'#60A5FA' }}>IP Webcam</strong> (Android) or <strong style={{ color:'#60A5FA' }}>EpocCam</strong> (iOS)</li>
              <li>Start the app on your phone</li>
              <li>Or use the browser microphone above</li>
              <li>Audio captured every 5 sec → analysed in real time</li>
            </ul>
            <div style={{ marginTop:'10px', fontFamily:'ui-monospace, monospace',
              fontSize:'10px', color:'#64748B',
              background:'rgba(0,0,0,0.30)', padding:'7px 10px',
              borderRadius:'7px', border:'1px solid #1F2937' }}>
              POST /api/livestream/chunk
            </div>
          </Card>

          {error && (
            <div style={{ padding:'12px 14px', borderRadius:'10px',
              background:'rgba(239,68,68,0.10)',
              border:'1px solid rgba(239,68,68,0.35)',
              color:'#FCA5A5', fontSize:'12px' }}>
              ⚠ {error}
            </div>
          )}

          {liveStatus && (
            <div style={{ marginTop:'12px', padding:'10px 14px', borderRadius:'10px',
              background:'rgba(59,130,246,0.06)',
              border:'1px solid rgba(59,130,246,0.25)',
              fontSize:'11px', color:'#94A3B8' }}>
              <span style={{ color:'#60A5FA', fontWeight:700 }}>Pipeline:</span>{' '}
              {liveStatus.stage || 'idle'}
            </div>
          )}
        </div>

        {/* ── RIGHT COL — Live results + history ─────────────── */}
        <div>
          {/* Latest chunk hero */}
          {current ? (
            <LatestChunk current={current}/>
          ) : (
            <Card>
              <div style={{ textAlign:'center', padding:'52px 0',
                color:'#64748B' }}>
                <div style={{ fontSize:'36px', opacity:0.4, marginBottom:'10px' }}>●</div>
                <div style={{ fontSize:'13px', fontWeight:600 }}>
                  {streaming
                    ? 'Waiting for first 5-second chunk…'
                    : 'Press "Start Live Recording" to begin'}
                </div>
                {streaming && (
                  <div style={{ fontSize:'11px', color:'#475569', marginTop:'5px' }}>
                    First analysis arrives in 5–10 seconds
                  </div>
                )}
              </div>
            </Card>
          )}

          {/* Chunk history */}
          <Card title={`Chunk History · ${results.length} analysed`}>
            {results.length === 0 ? (
              <div style={{ textAlign:'center', padding:'24px',
                color:'#64748B', fontSize:'12px' }}>
                Chunk history appears here as each 5-sec audio segment is analysed.
              </div>
            ) : (
              <div ref={scrollRef} style={{ maxHeight:'320px',
                overflowY:'auto', paddingRight:'4px' }}>
                {results.map((r, i) => (
                  <ChunkRow key={`${r._chunk}-${i}`} r={r} idx={i}/>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      <style>{`
        @keyframes liveDot {
          0%, 100% { box-shadow: 0 8px 20px rgba(239,68,68,0.40); }
          50%      { box-shadow: 0 8px 28px rgba(239,68,68,0.70); }
        }
        @keyframes pulseAlert {
          0%, 100% { box-shadow: 0 0 32px rgba(239,68,68,0.25); }
          50%      { box-shadow: 0 0 48px rgba(239,68,68,0.45); }
        }
      `}</style>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────
// Latest chunk hero card — score ring + violations + transcript
// ──────────────────────────────────────────────────────────────────
function LatestChunk({ current }) {
  const sev    = SEV[current.severity] || SEV.NORMAL
  const toneC  = TONE_COLOR[current.tone_label] || '#64748B'
  const viols  = current.violations || []

  return (
    <div style={{ padding:'20px 22px', borderRadius:'14px', marginBottom:'14px',
      background:`linear-gradient(135deg, ${sev.bg}, rgba(255,255,255,0.02))`,
      border:`1px solid ${sev.border}`, boxShadow:sev.glow,
      animation:'db-fadeIn .3s ease-out' }}>
      <div style={{ display:'flex', gap:'18px', alignItems:'center',
        marginBottom: (current.transcript || viols.length > 0) ? '16px' : 0 }}>
        <ScoreRing score={current.total_score} severity={current.severity} size={84}/>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ display:'flex', alignItems:'center', gap:'8px',
            marginBottom:'6px', flexWrap:'wrap' }}>
            <span style={{ fontSize:'10px', color:'#94A3B8',
              fontFamily:'ui-monospace, monospace', fontWeight:700 }}>
              CHUNK #{(current._chunk || 0) + 1}
            </span>
            <SevChip sev={current.severity}/>
            <span style={{ fontSize:'10px', fontWeight:800,
              padding:'2px 8px', borderRadius:'6px', letterSpacing:'0.06em',
              color:toneC, background:`${toneC}15`, border:`1px solid ${toneC}40` }}>
              {current.tone_label}
            </span>
          </div>
          <div style={{ fontSize:'14px', color:'#F1F5F9', fontWeight:700 }}>
            {viols.length} violation{viols.length === 1 ? '' : 's'} detected
          </div>
          <div style={{ fontSize:'11px', color:'#94A3B8', marginTop:'4px',
            display:'flex', gap:'12px', flexWrap:'wrap' }}>
            <span>◎ EO: {current.eo_detected ? `${current.eo_speaking_sec || 0}s` : 'not found'}</span>
            <span>· Tone: {current.tone_score || 0}/100</span>
            <span>· KW: {current.keyword_score || 0}/100</span>
          </div>
        </div>
      </div>

      {/* Transcript snippet */}
      {current.transcript && (
        <div style={{ padding:'10px 14px', borderRadius:'9px',
          background:'rgba(0,0,0,0.25)', borderLeft:'3px solid #3B82F6',
          fontSize:'12px', color:'#CBD5E1', lineHeight:1.65,
          marginBottom: viols.length > 0 ? '12px' : 0 }}>
          <span style={{ color:'#60A5FA', fontWeight:700,
            fontSize:'9px', letterSpacing:'0.10em',
            textTransform:'uppercase', display:'block',
            marginBottom:'4px' }}>Transcript</span>
          "{current.transcript.slice(0, 240)}{current.transcript.length > 240 ? '…' : ''}"
        </div>
      )}

      {/* Top-3 violations preview */}
      {viols.length > 0 && (
        <div style={{ display:'flex', gap:'8px', flexWrap:'wrap' }}>
          {viols.slice(0, 4).map((v, i) => {
            const vsev = SEV[v.severity] || SEV.WARNING
            return (
              <span key={i} style={{ display:'inline-flex', alignItems:'center',
                gap:'7px', padding:'5px 12px', borderRadius:'8px',
                fontSize:'11px', fontWeight:800,
                background:vsev.bg, color:vsev.color,
                border:`1px solid ${vsev.border}` }}>
                <span style={{ fontWeight:900 }}>+{v.score || 0}</span>
                {v.type}
              </span>
            )
          })}
          {viols.length > 4 && (
            <span style={{ padding:'5px 12px', fontSize:'11px',
              color:'#94A3B8', fontWeight:600 }}>
              +{viols.length - 4} more
            </span>
          )}
        </div>
      )}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────
// Compact chunk row in the history list
// ──────────────────────────────────────────────────────────────────
function ChunkRow({ r, idx }) {
  const sev   = SEV[r.severity] || SEV.NORMAL
  const toneC = TONE_COLOR[r.tone_label] || '#64748B'
  const pct   = Math.max(0, Math.min(100, r.total_score || 0))

  return (
    <div style={{ display:'flex', alignItems:'center', gap:'10px',
      padding:'9px 11px', marginBottom:'5px', borderRadius:'9px',
      background:'rgba(255,255,255,0.02)',
      border:`1px solid ${r.severity === 'CRITICAL' ? sev.border : '#1F2937'}`,
      boxShadow: r.severity === 'CRITICAL' ? '0 0 12px rgba(239,68,68,0.12)' : 'none' }}>
      <span style={{ fontFamily:'ui-monospace, monospace', fontSize:'10px',
        color:'#64748B', width:'34px', flexShrink:0 }}>
        #{(r._chunk || idx) + 1}
      </span>
      <SevChip sev={r.severity} small/>
      <span style={{ fontSize:'11px', color:toneC, fontWeight:700,
        minWidth:'66px' }}>{r.tone_label}</span>
      <span style={{ fontSize:'12px', fontWeight:800, color:sev.color,
        minWidth:'34px', textAlign:'right',
        fontVariantNumeric:'tabular-nums' }}>{r.total_score}</span>
      <div style={{ flex:1, height:'4px',
        background:'rgba(255,255,255,0.05)', borderRadius:'2px',
        overflow:'hidden' }}>
        <div style={{ width:`${pct}%`, height:'100%',
          background:sev.color, boxShadow:`0 0 6px ${sev.color}AA`,
          transition:'width 0.4s ease' }}/>
      </div>
      <span style={{ fontSize:'10px', color:'#64748B', whiteSpace:'nowrap',
        minWidth:'56px', textAlign:'right' }}>
        {r.eo_detected ? `EO ${r.eo_speaking_sec || 0}s` : '—'}
      </span>
      <span style={{ fontSize:'10px', fontWeight:700,
        color: r.violations?.length > 0 ? '#EF4444' : '#64748B',
        minWidth:'34px', textAlign:'right' }}>
        {r.violations?.length || 0} v
      </span>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────
// Small primitives
// ──────────────────────────────────────────────────────────────────
function Card({ title, children }) {
  return (
    <div style={{ padding:'18px 20px', marginBottom:'14px',
      borderRadius:'14px', background:'rgba(255,255,255,0.025)',
      border:'1px solid #1F2937' }}>
      {title && <div style={{ fontSize:'10px', color:'#64748B',
        fontWeight:800, letterSpacing:'0.10em', textTransform:'uppercase',
        marginBottom:'12px' }}>{title}</div>}
      {children}
    </div>
  )
}

function KpiTile({ label, val, color, suffix = '' }) {
  return (
    <div style={{ padding:'14px 16px', borderRadius:'12px',
      background:`linear-gradient(135deg, ${color}15, rgba(255,255,255,0.02))`,
      border:`1px solid ${color}30` }}>
      <div style={{ fontSize:'9px', color:'#64748B', fontWeight:800,
        letterSpacing:'0.10em', textTransform:'uppercase' }}>{label}</div>
      <div style={{ fontSize:'24px', fontWeight:900, color,
        marginTop:'4px', lineHeight:1, letterSpacing:'-0.02em',
        fontVariantNumeric:'tabular-nums' }}>
        {val}{suffix && <span style={{ fontSize:'13px',
          fontWeight:700, color:'#94A3B8', marginLeft:'2px' }}>{suffix}</span>}
      </div>
    </div>
  )
}

function ScoreRing({ score, severity, size = 80 }) {
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
          style={{ transition:'stroke-dashoffset 0.5s ease',
            filter:`drop-shadow(0 0 6px ${sev.color}80)` }}/>
      </svg>
      <div style={{ position:'absolute', inset:0, display:'flex',
        flexDirection:'column', alignItems:'center', justifyContent:'center' }}>
        <div style={{ fontSize:'20px', fontWeight:900, color:sev.color,
          lineHeight:1, letterSpacing:'-0.02em' }}>{score || 0}</div>
        <div style={{ fontSize:'9px', color:'#64748B',
          fontWeight:800, letterSpacing:'0.10em', marginTop:'2px' }}>/100</div>
      </div>
    </div>
  )
}

function SevChip({ sev, small }) {
  const m = SEV[sev] || SEV.NORMAL
  const sz = small ? { padding:'2px 7px', fontSize:'9px' }
                   : { padding:'3px 10px', fontSize:'10px' }
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:'5px',
      ...sz, borderRadius:'6px', fontWeight:800, letterSpacing:'0.06em',
      textTransform:'uppercase',
      color:m.color, background:m.bg, border:`1px solid ${m.border}` }}>
      <span style={{ width:5, height:5, borderRadius:'50%',
        background:m.color, boxShadow:`0 0 5px ${m.color}` }}/>
      {sev}
    </span>
  )
}

function Pill({ color, pulse, children }) {
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:'7px',
      padding:'6px 14px', borderRadius:'9px',
      fontSize:'12px', fontWeight:800, letterSpacing:'0.04em',
      color, background:`${color}15`, border:`1px solid ${color}40`,
      animation: pulse ? 'liveDot 1.4s infinite' : 'none' }}>
      {children}
    </span>
  )
}

const labelStyle = {
  fontSize:'10px', color:'#64748B', fontWeight:800,
  letterSpacing:'0.10em', textTransform:'uppercase', display:'block',
}
function Label({ children }) {
  return <label style={{ ...labelStyle, marginBottom:'7px' }}>{children}</label>
}

const selectStyle = {
  width:'100%', padding:'9px 12px', fontSize:'13px',
  background:'rgba(0,0,0,0.30)', color:'#F1F5F9',
  border:'1px solid #1F2937', borderRadius:'9px', outline:'none',
  cursor:'pointer',
}

const startBtnStyle = {
  width:'100%', padding:'13px', borderRadius:'12px', cursor:'pointer',
  background:'linear-gradient(135deg, #EF4444, #DC2626)',
  color:'#fff', border:'none',
  fontSize:'14px', fontWeight:800, letterSpacing:'0.04em',
  display:'flex', alignItems:'center', justifyContent:'center', gap:'10px',
  boxShadow:'0 10px 24px rgba(239,68,68,0.30)',
  transition:'all .2s',
}

const stopBtnStyle = {
  width:'100%', padding:'13px', borderRadius:'12px', cursor:'pointer',
  background:'rgba(239,68,68,0.10)', color:'#EF4444',
  border:'1px solid rgba(239,68,68,0.40)',
  fontSize:'14px', fontWeight:800, letterSpacing:'0.04em',
  display:'flex', alignItems:'center', justifyContent:'center', gap:'10px',
  transition:'all .2s',
}
