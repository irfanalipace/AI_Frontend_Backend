import React, { useState, useEffect } from 'react'
import { SeverityBadge, ViolationCard, ScoreRing, ScoreBar, Spinner } from '../components/UI'
import ApiService from '../services/api'

const CARD  = { background:'#ffffff', border:'0.5px solid #D3D1C7', borderRadius:'12px', padding:'20px' }
const LABEL = { fontSize:'10px', color:'#888780', textTransform:'uppercase', letterSpacing:'0.07em', fontWeight:700, marginBottom:'10px', display:'block' }

export default function Incidents({ alerts, markRead, clearAlerts }) {
  const [items,    setItems]    = useState([])
  const [loading,  setLoading]  = useState(true)
  const [filter,   setFilter]   = useState('ALL')
  const [selected, setSelected] = useState(null)
  const [page,     setPage]     = useState(1)
  const [total,    setTotal]    = useState(0)

  const load = async (sev=filter, pg=page) => {
    setLoading(true)
    try {
      const r = await ApiService.getIncidents({ severity:sev==='ALL'?'':sev, page:pg, limit:15 })
      setItems(r.data.incidents); setTotal(r.data.total)
    } catch(e) {}
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [filter, page])

  const FCOL = { ALL:'#185FA5', CRITICAL:'#E24B4A', WARNING:'#BA7517', NORMAL:'#1D9E75' }
  const unread = alerts.filter(a => !a.read)

  return (
    <div style={{ padding:'28px', maxWidth:'1200px' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'24px' }}>
        <div>
          <h1 style={{ fontSize:'22px', fontWeight:700, color:'#2C2C2A', marginBottom:'4px' }}>Incidents</h1>
          <p style={{ fontSize:'13px', color:'#888780' }}>{total} total recordings analyzed</p>
        </div>
        {unread.length > 0 && (
          <div style={{ display:'flex', alignItems:'center', gap:'10px' }}>
            <span style={{ background:'#FCEBEB', color:'#A32D2D', border:'0.5px solid #F09595', fontSize:'12px', padding:'5px 12px', borderRadius:'8px', fontWeight:700 }}>{unread.length} new alerts</span>
            <button onClick={clearAlerts} style={{ fontSize:'12px', color:'#888780', background:'transparent', border:'none', cursor:'pointer' }}>Clear all</button>
          </div>
        )}
      </div>

      {/* Alert banners */}
      {unread.slice(0,3).map(a => (
        <div key={a._id} onClick={() => markRead(a._id)}
          style={{ display:'flex', alignItems:'center', gap:'12px', padding:'11px 15px', marginBottom:'10px', borderRadius:'10px', cursor:'pointer',
            background:a.severity==='CRITICAL'?'#FCEBEB':'#FAEEDA',
            border:`0.5px solid ${a.severity==='CRITICAL'?'#F09595':'#FAC775'}` }}>
          <div style={{ width:8, height:8, borderRadius:'50%', background:a.severity==='CRITICAL'?'#E24B4A':'#BA7517', animation:'pulse 1s infinite', flexShrink:0 }}/>
          <SeverityBadge severity={a.severity}/>
          <span style={{ fontSize:'13px', color:'#2C2C2A', fontWeight:600 }}>{a.officer_id}</span>
          <span style={{ fontSize:'13px', color:'#5F5E5A' }}>Score: {a.total_score}/100</span>
          <span style={{ fontSize:'11px', color:'#888780', flex:1, textAlign:'right' }}>{new Date(a.timestamp).toLocaleTimeString()} · tap to dismiss</span>
        </div>
      ))}

      {/* Filters */}
      <div style={{ display:'flex', gap:'8px', marginBottom:'16px' }}>
        {['ALL','CRITICAL','WARNING','NORMAL'].map(f => (
          <button key={f} onClick={() => { setFilter(f); setPage(1); setSelected(null) }}
            style={{ padding:'7px 16px', borderRadius:'8px', fontSize:'12px', fontWeight:600, cursor:'pointer', transition:'all .15s',
              background:filter===f?FCOL[f]:'#ffffff',
              color:filter===f?'#ffffff':'#5F5E5A',
              border:`0.5px solid ${filter===f?FCOL[f]:'#D3D1C7'}` }}>
            {f}
          </button>
        ))}
        <button onClick={() => load()} style={{ marginLeft:'auto', padding:'7px 14px', borderRadius:'8px', fontSize:'12px', cursor:'pointer', color:'#5F5E5A', background:'#ffffff', border:'0.5px solid #D3D1C7' }}>Refresh</button>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'16px' }}>
        {/* List */}
        <div>
          {loading ? (
            <div style={{ textAlign:'center', padding:'50px' }}><Spinner size={28}/></div>
          ) : items.length === 0 ? (
            <div style={{ ...CARD, textAlign:'center', padding:'50px', color:'#B4B2A9' }}>
              <div style={{ fontSize:'13px' }}>No incidents found</div>
            </div>
          ) : (
            <div>
              {items.map(inc => {
                const sc  = inc.total_score
                const col = sc>=70?'#E24B4A':sc>=40?'#BA7517':'#1D9E75'
                const sel = selected?.incident_id === inc.incident_id
                return (
                  <div key={inc.incident_id} onClick={() => setSelected(inc)} className="fade-in"
                    style={{ background:'#ffffff', border:`0.5px solid ${sel?'#185FA5':'#D3D1C7'}`, borderRadius:'10px', padding:'14px 16px', cursor:'pointer', marginBottom:'8px', transition:'all .15s', boxShadow:sel?'0 0 0 2px #185FA520':undefined }}>
                    <div style={{ display:'flex', alignItems:'flex-start', gap:'12px' }}>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ display:'flex', alignItems:'center', gap:'8px', marginBottom:'5px' }}>
                          <SeverityBadge severity={inc.severity}/>
                          <span style={{ fontFamily:'monospace', fontSize:'10px', color:'#B4B2A9' }}>{inc.incident_id}</span>
                        </div>
                        <div style={{ fontSize:'13px', fontWeight:600, color:'#2C2C2A', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', marginBottom:'3px' }}>{inc.filename}</div>
                        <div style={{ fontSize:'11px', color:'#888780' }}>{inc.officer_name} · {inc.source} · {new Date(inc.timestamp).toLocaleString()}</div>
                      </div>
                      <div style={{ textAlign:'right', flexShrink:0 }}>
                        <div style={{ fontSize:'20px', fontWeight:700, color:col }}>{sc}</div>
                        <ScoreBar score={sc} height={3}/>
                        <div style={{ fontSize:'10px', color:'#888780', marginTop:'3px' }}>{inc.violations?.length||0} violations</div>
                      </div>
                    </div>
                  </div>
                )
              })}
              {total > 15 && (
                <div style={{ display:'flex', justifyContent:'center', gap:'8px', paddingTop:'8px' }}>
                  <button onClick={() => setPage(p=>Math.max(1,p-1))} disabled={page===1}
                    style={{ padding:'6px 14px', background:'#ffffff', border:'0.5px solid #D3D1C7', borderRadius:'7px', color:'#5F5E5A', cursor:'pointer', fontSize:'12px' }}>← Prev</button>
                  <span style={{ fontSize:'12px', color:'#888780', padding:'6px 10px' }}>{page}/{Math.ceil(total/15)}</span>
                  <button onClick={() => setPage(p=>p+1)} disabled={page>=Math.ceil(total/15)}
                    style={{ padding:'6px 14px', background:'#ffffff', border:'0.5px solid #D3D1C7', borderRadius:'7px', color:'#5F5E5A', cursor:'pointer', fontSize:'12px' }}>Next →</button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Detail */}
        <div>
          {!selected ? (
            <div style={{ ...CARD, textAlign:'center', padding:'50px', color:'#B4B2A9' }}>
              <div style={{ fontSize:'28px', marginBottom:'10px' }}>⚑</div>
              <div style={{ fontSize:'13px' }}>Select an incident to see details</div>
            </div>
          ) : (
            <div className="slide-in">
              <div style={{ background:'#ffffff', border:'0.5px solid #D3D1C7', borderRadius:'12px', padding:'20px', marginBottom:'12px', display:'flex', gap:'18px', alignItems:'center' }}>
                <ScoreRing score={selected.total_score} severity={selected.severity} size={90}/>
                <div style={{ flex:1 }}>
                  <SeverityBadge severity={selected.severity}/>
                  <div style={{ fontSize:'12px', color:'#5F5E5A', marginTop:'6px' }}>{selected.officer_name} · {selected.source}</div>
                  <div style={{ fontSize:'11px', color:'#888780', marginTop:'2px' }}>{new Date(selected.timestamp).toLocaleString()}</div>
                  <div style={{ display:'flex', gap:'14px', marginTop:'8px', fontSize:'12px' }}>
                    <span style={{ color:'#185FA5', fontWeight:700 }}>Tone: {selected.tone_score}</span>
                    <span style={{ color:'#534AB7', fontWeight:700 }}>Keywords: {selected.keyword_score}</span>
                  </div>
                </div>
              </div>

              {selected.transcript && (
                <div style={{ background:'#ffffff', border:'0.5px solid #D3D1C7', borderRadius:'10px', padding:'14px', marginBottom:'12px' }}>
                  <span style={LABEL}>Auto-transcribed Speech</span>
                  <div style={{ fontSize:'12px', color:'#5F5E5A', fontStyle:'italic', lineHeight:1.7, background:'#F8F7F4', borderRadius:'7px', padding:'10px 12px', borderLeft:'3px solid #D3D1C7' }}>"{selected.transcript}"</div>
                </div>
              )}

              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:'8px', marginBottom:'12px' }}>
                {[
                  ['EO detected', selected.eo_detected?'Yes':'No', selected.eo_detected?'#1D9E75':'#E24B4A'],
                  ['EO speaking', `${selected.eo_speaking_sec}s`, '#185FA5'],
                  ['Tone', selected.tone_label, '#534AB7'],
                ].map(([l,v,c]) => (
                  <div key={l} style={{ background:'#F8F7F4', border:'0.5px solid #E8E6DF', borderRadius:'9px', padding:'12px' }}>
                    <div style={{ fontSize:'10px', color:'#888780', textTransform:'uppercase', letterSpacing:'0.06em', fontWeight:700, marginBottom:'5px' }}>{l}</div>
                    <div style={{ fontSize:'16px', fontWeight:700, color:c }}>{v}</div>
                  </div>
                ))}
              </div>

              <div style={{ background:'#ffffff', border:'0.5px solid #D3D1C7', borderRadius:'10px', padding:'14px' }}>
                <span style={LABEL}>Violations ({selected.violations?.length||0})</span>
                {selected.violations?.length > 0
                  ? selected.violations.map((v,i) => <ViolationCard key={i} v={v} index={i}/>)
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