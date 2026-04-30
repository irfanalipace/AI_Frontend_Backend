import React, { useState, useEffect } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts'
import { SeverityBadge, ScoreBar } from '../components/UI'
import ApiService from '../services/api'

const CARD  = { background:'#111827', border:'1px solid #1F2937', borderRadius:'16px', padding:'24px', marginBottom:'16px' }
const LABEL = { fontSize:'10px', color:'#64748B', textTransform:'uppercase', letterSpacing:'0.08em', fontWeight:700, marginBottom:'14px', display:'block' }
const TT    = { background:'#1A1F2E', border:'1px solid #2D3348', borderRadius:'10px', color:'#E2E8F0', fontSize:12 }

function Tile({ label, value, sub, color, icon }) {
  return (
    <div style={{ background:'#111827', border:'1px solid #1F2937', borderRadius:'16px', padding:'22px' }}>
      <div style={{ display:'flex', alignItems:'center', gap:'6px', marginBottom:'12px' }}>
        {icon && <span style={{ fontSize:'14px' }}>{icon}</span>}
        <span style={{ fontSize:'10px', color:'#64748B', textTransform:'uppercase',
          letterSpacing:'0.08em', fontWeight:700 }}>{label}</span>
      </div>
      <div style={{ fontSize:'32px', fontWeight:800, color:color||'#F1F5F9',
        marginBottom:'4px', letterSpacing:'-0.02em' }}>{value}</div>
      <div style={{ fontSize:'11px', color:'#475569' }}>{sub}</div>
    </div>
  )
}

export default function Dashboard() {
  const [stats,   setStats]   = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  const load = async () => {
    try {
      const [s, h] = await Promise.all([ApiService.getDashboard(), ApiService.health()])
      setStats({ ...s.data, health: h.data })
    } catch(e) { setError(true) }
    finally { setLoading(false) }
  }

  useEffect(() => { load(); const t = setInterval(load, 12000); return () => clearInterval(t) }, [])

  if (loading) return (
    <div style={{ padding:'80px', textAlign:'center' }}>
      <div style={{ width:36, height:36, borderRadius:'50%', border:'2px solid #1F2937',
        borderTopColor:'#3B82F6', animation:'spin .7s linear infinite', margin:'0 auto 16px' }}/>
      <div style={{ color:'#64748B', fontSize:'13px' }}>Loading dashboard...</div>
    </div>
  )

  if (error) return (
    <div style={{ padding:'40px' }}>
      <div style={{ background:'rgba(239,68,68,0.1)', border:'1px solid rgba(239,68,68,0.25)',
        borderRadius:'16px', padding:'28px' }}>
        <div style={{ fontWeight:800, color:'#EF4444', marginBottom:'10px', fontSize:'16px' }}>Server Offline</div>
        <code style={{ fontSize:'12px', background:'#1A1F2E', padding:'8px 14px', borderRadius:'8px',
          color:'#94A3B8', border:'1px solid #2D3348' }}>
          cd backend && python server.py
        </code>
      </div>
    </div>
  )

  const total   = stats?.total_analyzed || 0
  const pieData = [
    { name:'Critical', value:stats?.critical||0, color:'#EF4444' },
    { name:'Warning',  value:stats?.warning||0,  color:'#F59E0B' },
    { name:'Normal',   value:stats?.normal||0,   color:'#10B981' },
  ].filter(d => d.value > 0)

  const vtData = (stats?.violation_types||[]).slice(0,6).map(([name,count]) => ({
    name: name.replace(/_/g,' ').slice(0,12), count
  }))

  const recent = stats?.recent_incidents || []

  return (
    <div style={{ padding:'30px', maxWidth:'1260px' }}>

      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-end', marginBottom:'28px' }}>
        <div>
          <h1 style={{ fontSize:'26px', fontWeight:800, color:'#F1F5F9', marginBottom:'6px',
            letterSpacing:'-0.02em' }}>Dashboard</h1>
          <p style={{ fontSize:'13px', color:'#64748B' }}>Real-time EO monitoring · Violation detection overview</p>
        </div>
        {stats?.health && (
          <div style={{ textAlign:'right', fontSize:'11px', color:'#475569', lineHeight:1.9 }}>
            <div style={{ color:'#10B981', fontWeight:700 }}>● System Active</div>
            <div>Whisper: {stats.health.whisper_available ? '✓ Online' : '○ Offline'}</div>
            <div>SVM: {stats.health.tone_cv_acc}% · {stats.health.total_keywords} keywords</div>
          </div>
        )}
      </div>

      {/* Metric tiles */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:'14px', marginBottom:'20px' }}>
        <Tile label="Total Analyzed"  icon="📊" value={total}                       sub="all recordings"  color="#3B82F6"/>
        <Tile label="Critical Alerts" icon="🚨" value={stats?.critical||0}          sub="action required" color="#EF4444"/>
        <Tile label="Warnings"        icon="⚡" value={stats?.warning||0}           sub="review needed"   color="#F59E0B"/>
        <Tile label="Avg Score"       icon="📈" value={`${stats?.avg_score||0}/100`} sub="all recordings"
          color={(stats?.avg_score||0)>=70?'#EF4444':(stats?.avg_score||0)>=40?'#F59E0B':'#10B981'}/>
      </div>

      {/* Charts */}
      <div style={{ display:'grid', gridTemplateColumns:'280px 1fr', gap:'16px', marginBottom:'16px' }}>
        <div style={CARD}>
          <span style={LABEL}>Severity Breakdown</span>
          {total === 0 ? (
            <div style={{ textAlign:'center', padding:'30px 0', color:'#475569', fontSize:'13px' }}>No recordings yet</div>
          ) : (
            <>
              <div style={{ display:'flex', justifyContent:'center', marginBottom:'18px' }}>
                <PieChart width={170} height={170}>
                  <Pie data={pieData} cx={80} cy={80} innerRadius={46} outerRadius={76} dataKey="value" paddingAngle={3}>
                    {pieData.map((e,i) => <Cell key={i} fill={e.color}/>)}
                  </Pie>
                  <Tooltip contentStyle={TT}/>
                </PieChart>
              </div>
              {pieData.map(d => (
                <div key={d.name} style={{ display:'flex', alignItems:'center', gap:'10px', padding:'8px 0',
                  borderBottom:'1px solid #1F2937', fontSize:'13px' }}>
                  <div style={{ width:10, height:10, borderRadius:'4px', background:d.color,
                    flexShrink:0, boxShadow:`0 0 6px ${d.color}40` }}/>
                  <span style={{ color:'#94A3B8', flex:1 }}>{d.name}</span>
                  <span style={{ fontWeight:800, color:'#F1F5F9' }}>{d.value}</span>
                  <span style={{ color:'#475569', fontSize:'11px' }}>({total>0?Math.round(d.value/total*100):0}%)</span>
                </div>
              ))}
            </>
          )}
        </div>

        <div style={CARD}>
          <span style={LABEL}>Top Violation Types</span>
          {vtData.length === 0 ? (
            <div style={{ textAlign:'center', padding:'40px 0', color:'#475569', fontSize:'13px' }}>Analyze recordings to see distribution</div>
          ) : (
            <ResponsiveContainer width="100%" height={210}>
              <BarChart data={vtData} margin={{ left:-20 }}>
                <XAxis dataKey="name" tick={{ fill:'#64748B', fontSize:10 }} axisLine={false} tickLine={false}/>
                <YAxis tick={{ fill:'#64748B', fontSize:10 }} axisLine={false} tickLine={false}/>
                <Tooltip contentStyle={TT}/>
                <Bar dataKey="count" fill="#3B82F6" radius={[6,6,0,0]}/>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Pipeline */}
      <div style={{ ...CARD, marginBottom:'16px' }}>
        <span style={LABEL}>AI Detection Pipeline — 7-Stage Analysis</span>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:'10px' }}>
          {[
            { icon:'🎙', color:'#3B82F6', title:'Voice Activity Detection', desc:'Energy + ZCR filtering removes traffic, animals, silence' },
            { icon:'👤', color:'#8B5CF6', title:'EO Voice Identification',  desc:'106-dim MFCC voiceprint matches officer among all speakers' },
            { icon:'🌐', color:'#10B981', title:'Groq Whisper Large-v3',   desc:'Cloud AI transcribes Urdu/English/Punjabi with 95% accuracy' },
            { icon:'🧠', color:'#F59E0B', title:'Tone SVM Classifier',     desc:'NORMAL / HARSH / ANGRY / BRIBE_TONE — 99.7% accuracy' },
            { icon:'🔍', color:'#EF4444', title:'588 Keyword Scanner',     desc:'10 categories: rishwat, dhamki, gali, rude, harassment, power...' },
            { icon:'📊', color:'#A855F7', title:'Voice Acoustics',         desc:'Pitch, energy, agitation, loud duration — detects shouting' },
            { icon:'🚨', color:'#06B6D4', title:'Score + Alert',           desc:'Score 0–100 → NORMAL / WARNING / CRITICAL → instant alert' },
          ].map((s, i) => (
            <div key={i} style={{ background:'#0B0F1A', border:'1px solid #1F2937',
              borderRadius:'12px', padding:'16px', display:'flex', gap:'12px', alignItems:'flex-start' }}>
              <div style={{ fontSize:'20px', flexShrink:0 }}>{s.icon}</div>
              <div>
                <div style={{ fontSize:'12px', fontWeight:700, color:s.color, marginBottom:'4px' }}>{s.title}</div>
                <div style={{ fontSize:'11px', color:'#64748B', lineHeight:1.5 }}>{s.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Recent incidents */}
      <div style={CARD}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'18px' }}>
          <span style={{ ...LABEL, marginBottom:0 }}>Recent Incidents</span>
          <button style={{ fontSize:'12px', color:'#3B82F6', background:'transparent', border:'none',
            cursor:'pointer', fontWeight:600 }}>View all →</button>
        </div>
        {recent.length === 0 ? (
          <div style={{ textAlign:'center', padding:'40px 0' }}>
            <div style={{ fontSize:'32px', color:'#1F2937', marginBottom:'12px' }}>⬡</div>
            <div style={{ fontSize:'13px', color:'#475569', fontWeight:600 }}>No incidents yet</div>
            <div style={{ fontSize:'11px', color:'#374151', marginTop:'6px' }}>Upload audio to start detection</div>
          </div>
        ) : (
          <div>
            <div style={{ display:'grid', gridTemplateColumns:'90px 140px 1fr 120px 100px 80px',
              gap:'8px', paddingBottom:'12px', borderBottom:'1px solid #1F2937' }}>
              {['ID','Officer','File','Severity','Score','Time'].map(h => (
                <div key={h} style={{ fontSize:'10px', color:'#475569', textTransform:'uppercase',
                  letterSpacing:'0.07em', fontWeight:700 }}>{h}</div>
              ))}
            </div>
            {recent.map(inc => {
              const sc  = inc.total_score
              const col = sc>=70?'#EF4444':sc>=40?'#F59E0B':'#10B981'
              return (
                <div key={inc.incident_id} style={{ display:'grid',
                  gridTemplateColumns:'90px 140px 1fr 120px 100px 80px',
                  gap:'8px', padding:'12px 0', borderBottom:'1px solid #1F2937', alignItems:'center' }}>
                  <div style={{ fontFamily:'monospace', fontSize:'11px', color:'#475569' }}>{inc.incident_id}</div>
                  <div style={{ fontSize:'12px', color:'#F1F5F9', fontWeight:700 }}>{inc.officer_name}</div>
                  <div style={{ fontSize:'11px', color:'#64748B', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{inc.filename}</div>
                  <div><SeverityBadge severity={inc.severity}/></div>
                  <div>
                    <div style={{ fontSize:'16px', fontWeight:800, color:col, marginBottom:'4px' }}>{sc}</div>
                    <ScoreBar score={sc} height={3}/>
                  </div>
                  <div style={{ fontSize:'11px', color:'#475569' }}>{inc.timestamp?.slice(11,19)}</div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
