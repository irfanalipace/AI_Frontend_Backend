import React, { useState, useRef, useEffect } from 'react'
import { ScoreRing, ViolationCard, SeverityBadge, ScoreBar, Spinner } from '../components/UI'
import ApiService from '../services/api'

const CARD  = { background:'#ffffff', border:'0.5px solid #D3D1C7', borderRadius:'12px', padding:'20px', marginBottom:'14px' }
const LABEL = { fontSize:'10px', color:'#888780', textTransform:'uppercase', letterSpacing:'0.07em', fontWeight:700, marginBottom:'8px', display:'block' }

export default function LiveStream({ liveStatus }) {
  const [streaming,  setStreaming]  = useState(false)
  const [officerId,  setOfficerId]  = useState('EO_001')
  const [sessionId]                 = useState(() => `LIVE_${Date.now()}`)
  const [chunkIdx,   setChunkIdx]   = useState(0)
  const [results,    setResults]    = useState([])
  const [current,    setCurrent]    = useState(null)
  const [error,      setError]      = useState(null)
  const mediaRef  = useRef(null)
  const recRef    = useRef(null)
  const chunkRef  = useRef(0)
  const scrollRef = useRef(null)

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [results])

  const startStream = async () => {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio:true })
      mediaRef.current = stream
      chunkRef.current = 0; setChunkIdx(0); setResults([]); setCurrent(null)
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg'
      const rec  = new MediaRecorder(stream, { mimeType:mime })
      recRef.current = rec
      rec.ondataavailable = async e => {
        if (e.data.size < 500) return
        const idx = chunkRef.current++
        setChunkIdx(idx+1)
        try {
          const r = await ApiService.sendChunk(e.data, officerId, sessionId, idx)
          r.data._chunk = idx; setCurrent(r.data)
          setResults(p => [...p.slice(-29), r.data])
        } catch(err) { console.error(err) }
      }
      rec.start(5000); setStreaming(true)
    } catch(e) { setError(`Microphone error: ${e.message}`) }
  }

  const stopStream = () => {
    recRef.current?.stop()
    mediaRef.current?.getTracks().forEach(t => t.stop())
    setStreaming(false)
  }

  const sc = s => ({ CRITICAL:'#E24B4A', WARNING:'#BA7517', NORMAL:'#1D9E75' }[s]||'#888780')

  return (
    <div style={{ padding:'28px', maxWidth:'1100px' }}>
      <div style={{ marginBottom:'24px' }}>
        <h1 style={{ fontSize:'22px', fontWeight:700, color:'#2C2C2A', marginBottom:'4px' }}>Live Stream Detection</h1>
        <p style={{ fontSize:'13px', color:'#888780' }}>Record from microphone or body cam · Every 5 seconds analyzed in real time</p>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'320px 1fr', gap:'20px', alignItems:'start' }}>
        <div>
          <div style={CARD}>
            <span style={LABEL}>Stream Setup</span>
            <div style={{ marginBottom:'12px' }}>
              <label style={LABEL}>Officer</label>
              <select value={officerId} onChange={e => setOfficerId(e.target.value)} disabled={streaming}>
                <option value="EO_001">Irfan Ali — EO_001</option>
                <option value="EO_002">Umar Farooq — EO_002</option>
                <option value="EO_003">Fatima Malik — EO_003</option>
              </select>
            </div>
            <div>
              <label style={LABEL}>Session ID</label>
              <div style={{ fontFamily:'monospace', fontSize:'11px', color:'#888780', background:'#F8F7F4', borderRadius:'7px', padding:'9px 12px', border:'0.5px solid #E8E6DF' }}>{sessionId}</div>
            </div>
          </div>

          <div style={CARD}>
            {!streaming ? (
              <button onClick={startStream}
                style={{ width:'100%', padding:'12px', background:'#E24B4A', color:'#fff', border:'none', borderRadius:'10px', fontSize:'14px', fontWeight:700, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', gap:'8px' }}>
                ● Start Live Recording
              </button>
            ) : (
              <button onClick={stopStream}
                style={{ width:'100%', padding:'12px', background:'#FCEBEB', color:'#A32D2D', border:'0.5px solid #F09595', borderRadius:'10px', fontSize:'14px', fontWeight:700, cursor:'pointer' }}>
                ■ Stop Recording
              </button>
            )}
            {streaming && (
              <div style={{ display:'flex', alignItems:'center', gap:'8px', marginTop:'12px', fontSize:'12px' }}>
                <div style={{ width:8, height:8, borderRadius:'50%', background:'#E24B4A', animation:'pulse 1s infinite' }}/>
                <span style={{ color:'#A32D2D', fontWeight:700 }}>LIVE RECORDING</span>
                <span style={{ color:'#888780', marginLeft:'auto' }}>{chunkIdx} chunks</span>
              </div>
            )}
          </div>

          <div style={{ ...CARD, background:'#F8F7F4', border:'0.5px solid #E8E6DF', fontSize:'11px', color:'#888780', lineHeight:1.8 }}>
            <span style={LABEL}>Mobile as Body Cam</span>
            <div>1. Install <span style={{ color:'#185FA5', fontWeight:600 }}>IP Webcam</span> (Android) or <span style={{ color:'#185FA5', fontWeight:600 }}>EpocCam</span> (iOS)</div>
            <div>2. Start the app on your phone</div>
            <div>3. Or use the browser mic button above</div>
            <div>4. Audio captured every 5s and analyzed</div>
            <div style={{ marginTop:'8px', fontFamily:'monospace', fontSize:'10px', color:'#B4B2A9', background:'#ffffff', padding:'6px 8px', borderRadius:'5px', border:'0.5px solid #D3D1C7' }}>POST /api/livestream/chunk</div>
          </div>

          {error && <div style={{ background:'#FCEBEB', border:'0.5px solid #F09595', borderRadius:'8px', padding:'11px 13px', fontSize:'12px', color:'#A32D2D' }}>{error}</div>}
        </div>

        <div>
          {current ? (
            <div className="fade-in" style={CARD}>
              <span style={LABEL}>Latest · Chunk #{(current._chunk||0)+1}</span>
              <div style={{ display:'flex', gap:'18px', alignItems:'center', marginBottom:'14px' }}>
                <ScoreRing score={current.total_score} severity={current.severity} size={80}/>
                <div style={{ flex:1 }}>
                  <SeverityBadge severity={current.severity}/>
                  <div style={{ fontSize:'12px', color:'#888780', marginTop:'8px' }}>
                    EO: {current.eo_detected?'detected':'not found'} · Tone: {current.tone_label} · {current.violations?.length||0} violations
                  </div>
                  {current.transcript && (
                    <div style={{ fontSize:'11px', color:'#5F5E5A', marginTop:'7px', fontStyle:'italic', background:'#F8F7F4', padding:'6px 9px', borderRadius:'6px', borderLeft:'3px solid #D3D1C7' }}>
                      "{current.transcript.slice(0,80)}{current.transcript.length>80?'...':''}"
                    </div>
                  )}
                </div>
              </div>
              {current.violations?.length > 0 && current.violations.slice(0,3).map((v,i) => <ViolationCard key={i} v={v}/>)}
            </div>
          ) : (
            <div style={{ ...CARD, textAlign:'center', padding:'50px', color:'#B4B2A9' }}>
              <div style={{ fontSize:'28px', marginBottom:'10px' }}>●</div>
              <div style={{ fontSize:'13px', fontWeight:600 }}>{streaming?'Waiting for first 5-second chunk...':'Start recording to see results'}</div>
            </div>
          )}

          <div style={CARD}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'12px' }}>
              <span style={{ ...LABEL, marginBottom:0 }}>Chunk History</span>
              <span style={{ fontSize:'11px', color:'#888780' }}>{results.length} analyzed</span>
            </div>
            <div ref={scrollRef} style={{ maxHeight:'220px', overflowY:'auto' }}>
              {results.length === 0 ? (
                <div style={{ textAlign:'center', padding:'20px', color:'#B4B2A9', fontSize:'12px' }}>No chunks yet</div>
              ) : results.map((r,i) => (
                <div key={i} style={{ display:'flex', alignItems:'center', gap:'10px', padding:'8px 10px', borderRadius:'8px', background:'#F8F7F4', border:'0.5px solid #E8E6DF', marginBottom:'5px', fontSize:'11px' }}>
                  <span style={{ fontFamily:'monospace', color:'#888780', width:'32px' }}>#{(r._chunk||i)+1}</span>
                  <SeverityBadge severity={r.severity}/>
                  <span style={{ fontWeight:700, color:sc(r.severity) }}>{r.total_score}/100</span>
                  <div style={{ flex:1 }}><ScoreBar score={r.total_score} height={3}/></div>
                  <span style={{ color:'#888780', whiteSpace:'nowrap' }}>{r.eo_detected?`EO ${r.eo_speaking_sec}s`:'—'}</span>
                </div>
              ))}
            </div>
            {results.length > 0 && (
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:'8px', marginTop:'12px', paddingTop:'12px', borderTop:'0.5px solid #E8E6DF' }}>
                {[
                  ['Critical', results.filter(r=>r.severity==='CRITICAL').length, '#E24B4A', '#FCEBEB'],
                  ['Warning',  results.filter(r=>r.severity==='WARNING').length,  '#BA7517', '#FAEEDA'],
                  ['Normal',   results.filter(r=>r.severity==='NORMAL').length,   '#1D9E75', '#E1F5EE'],
                ].map(([l,v,c,bg]) => (
                  <div key={l} style={{ textAlign:'center', background:bg, borderRadius:'8px', padding:'10px', border:`0.5px solid ${c}30` }}>
                    <div style={{ fontSize:'20px', fontWeight:700, color:c }}>{v}</div>
                    <div style={{ fontSize:'10px', color:c, marginTop:'2px', fontWeight:600 }}>{l}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}