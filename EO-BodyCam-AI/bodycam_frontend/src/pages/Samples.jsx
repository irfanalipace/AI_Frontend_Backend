import React, { useState, useEffect } from 'react'
import { ScoreRing, ViolationCard, ToneBar, SeverityBadge, Spinner } from '../components/UI'
import ApiService from '../services/api'

const CARD  = { background:'#ffffff', border:'0.5px solid #D3D1C7', borderRadius:'12px', padding:'20px' }
const LABEL = { fontSize:'10px', color:'#888780', textTransform:'uppercase', letterSpacing:'0.07em', fontWeight:700, marginBottom:'10px', display:'block' }

export default function Samples() {
  const [samples,   setSamples]   = useState([])
  const [loading,   setLoading]   = useState(true)
  const [analyzing, setAnalyzing] = useState(null)
  const [result,    setResult]    = useState(null)
  const [error,     setError]     = useState(null)

  useEffect(() => {
    ApiService.getSamples()
      .then(r => setSamples(r.data.samples))
      .catch(() => setError('Cannot reach server'))
      .finally(() => setLoading(false))
  }, [])

  const analyze = async fname => {
    setAnalyzing(fname); setResult(null); setError(null)
    try { const r = await ApiService.analyzeSample(fname); setResult(r.data) }
    catch(e) { setError(e.response?.data?.error||'Server error') }
    finally { setAnalyzing(null) }
  }

  const ec = e => e==='CRITICAL'?'#E24B4A':e==='WARNING'?'#BA7517':'#1D9E75'
  const eb = e => e==='CRITICAL'?'#FCEBEB':e==='WARNING'?'#FAEEDA':'#E1F5EE'

  return (
    <div style={{ padding:'28px', maxWidth:'1200px' }}>
      <div style={{ marginBottom:'24px' }}>
        <h1 style={{ fontSize:'22px', fontWeight:700, color:'#2C2C2A', marginBottom:'4px' }}>Test Samples</h1>
        <p style={{ fontSize:'13px', color:'#888780' }}>Built-in audio files — click any to run full AI analysis instantly</p>
      </div>

      {error && <div style={{ background:'#FCEBEB', border:'0.5px solid #F09595', borderRadius:'8px', padding:'12px 14px', fontSize:'12px', color:'#A32D2D', marginBottom:'16px' }}>{error}</div>}

      <div style={{ display:'grid', gridTemplateColumns:'360px 1fr', gap:'20px', alignItems:'start' }}>
        <div>
          {loading ? <div style={{ textAlign:'center', padding:'40px' }}><Spinner size={28}/></div> : (
            <div>
              {samples.map(s => {
                const active = analyzing === s.filename
                const sel    = result?.filename === s.filename
                const color  = ec(s.expected_severity)
                const bg     = eb(s.expected_severity)
                return (
                  <button key={s.filename} onClick={() => analyze(s.filename)} disabled={!!analyzing}
                    style={{ background:sel?'#EEF5FB':'#ffffff', border:`0.5px solid ${sel?'#185FA5':'#D3D1C7'}`, borderRadius:'10px', padding:'12px 14px', cursor:analyzing?'wait':'pointer', textAlign:'left', width:'100%', marginBottom:'6px', transition:'all .15s', opacity:analyzing&&!active?0.5:1, display:'block' }}>
                    <div style={{ display:'flex', gap:'10px', alignItems:'center' }}>
                      {active ? <Spinner size={14}/> : (
                        <div style={{ width:14, height:14, borderRadius:'50%', border:`2px solid ${sel?'#185FA5':'#D3D1C7'}`, background:sel?'#185FA5':'transparent', flexShrink:0 }}/>
                      )}
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:'12px', fontWeight:600, color:'#2C2C2A', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{s.filename.replace('.wav','')}</div>
                        <div style={{ fontSize:'10px', color:'#888780', marginTop:'2px' }}>{s.duration_sec}s · energy {s.energy}</div>
                      </div>
                      <span style={{ fontSize:'10px', fontWeight:700, padding:'2px 8px', borderRadius:'6px', flexShrink:0, background:bg, color, border:`0.5px solid ${color}40` }}>{s.expected_severity}</span>
                    </div>
                  </button>
                )
              })}
            </div>
          )}

          <div style={{ background:'#F8F7F4', border:'0.5px solid #E8E6DF', borderRadius:'10px', padding:'14px', marginTop:'8px', fontSize:'11px', color:'#888780', lineHeight:1.8 }}>
            <span style={LABEL}>Sample Descriptions</span>
            <div><span style={{ color:'#185FA5', fontWeight:600 }}>eo_normal</span> — Calm professional challan</div>
            <div><span style={{ color:'#E24B4A', fontWeight:600 }}>eo_harsh</span> — Shouting, high pitch</div>
            <div><span style={{ color:'#E24B4A', fontWeight:600 }}>eo_bribe</span> — Bribe language (quiet)</div>
            <div><span style={{ color:'#E24B4A', fontWeight:600 }}>eo_threat</span> — Jail/arrest threats</div>
            <div><span style={{ color:'#BA7517', fontWeight:600 }}>market_scene_*</span> — Mixed crowd + EO</div>
          </div>
        </div>

        <div>
          {analyzing && (
            <div style={{ ...CARD, textAlign:'center', padding:'50px' }}>
              <Spinner size={32}/>
              <div style={{ fontSize:'14px', fontWeight:600, color:'#2C2C2A', marginTop:'16px', marginBottom:'6px' }}>Analyzing {analyzing}...</div>
              <div style={{ fontSize:'11px', color:'#888780' }}>VAD → EO ID → Whisper → SVM → Keywords</div>
            </div>
          )}
          {!analyzing && !result && (
            <div style={{ ...CARD, textAlign:'center', padding:'50px', color:'#B4B2A9' }}>
              <div style={{ fontSize:'28px', marginBottom:'10px' }}>▦</div>
              <div style={{ fontSize:'13px', fontWeight:600 }}>Click any sample to analyze</div>
            </div>
          )}
          {result && !analyzing && (
            <div className="fade-in">
              <div style={{ fontFamily:'monospace', fontSize:'10px', color:'#B4B2A9', marginBottom:'8px' }}>{result.filename}</div>

              <div style={{ ...CARD, display:'flex', gap:'18px', alignItems:'center', marginBottom:'12px' }}>
                <ScoreRing score={result.total_score} severity={result.severity} size={90}/>
                <div style={{ flex:1 }}>
                  <SeverityBadge severity={result.severity}/>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'6px', marginTop:'10px', fontSize:'12px' }}>
                    <div style={{ color:'#888780' }}>EO: <span style={{ color:result.eo_detected?'#1D9E75':'#E24B4A', fontWeight:700 }}>{result.eo_detected?'Detected':'Not found'}</span></div>
                    <div style={{ color:'#888780' }}>Tone: <span style={{ color:'#534AB7', fontWeight:700 }}>{result.tone_label}</span></div>
                    <div style={{ color:'#888780' }}>Tone score: <span style={{ color:'#185FA5', fontWeight:700 }}>{result.tone_score}/50</span></div>
                    <div style={{ color:'#888780' }}>KW score: <span style={{ color:'#534AB7', fontWeight:700 }}>{result.keyword_score}/50</span></div>
                  </div>
                </div>
              </div>

              {result.transcript && (
                <div style={{ ...CARD, marginBottom:'12px' }}>
                  <span style={LABEL}>Auto-transcribed Speech</span>
                  <div style={{ fontSize:'12px', color:'#5F5E5A', fontStyle:'italic', background:'#F8F7F4', borderRadius:'7px', padding:'10px 12px', borderLeft:'3px solid #D3D1C7', lineHeight:1.7 }}>"{result.transcript}"</div>
                </div>
              )}

              <div style={{ ...CARD, marginBottom:'12px' }}>
                <span style={LABEL}>SVM Tone Probabilities</span>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:'8px' }}>
                  {['NORMAL','HARSH','BRIBE_TONE'].map(l => (
                    <ToneBar key={l} label={l} prob={result.tone_proba?.[l]||0} active={result.tone_label===l}/>
                  ))}
                </div>
              </div>

              <div style={CARD}>
                <span style={LABEL}>Violations ({result.violations?.length||0})</span>
                {result.violations?.length > 0
                  ? result.violations.map((v,i) => <ViolationCard key={i} v={v} index={i}/>)
                  : <div style={{ textAlign:'center', padding:'16px', color:'#1D9E75', fontSize:'13px' }}>✓ No violations</div>
                }
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}