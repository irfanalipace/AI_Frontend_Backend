import React from 'react'

// ── Dark theme severity colors ──
export const SEV = {
  CRITICAL: { bg:'rgba(239,68,68,0.12)', border:'rgba(239,68,68,0.3)', text:'#EF4444', glow:'rgba(239,68,68,0.2)', icon:'⚠' },
  WARNING:  { bg:'rgba(245,158,11,0.12)', border:'rgba(245,158,11,0.3)', text:'#F59E0B', glow:'rgba(245,158,11,0.15)', icon:'⚡' },
  NORMAL:   { bg:'rgba(16,185,129,0.12)', border:'rgba(16,185,129,0.3)', text:'#10B981', glow:'rgba(16,185,129,0.15)', icon:'✓' },
}

export const CATEGORY_STYLE = {
  RISHWAT:        { icon:'💰', color:'#EF4444', bg:'rgba(239,68,68,0.1)',  label:'Bribery' },
  DHAMKI:         { icon:'⚠',  color:'#F97316', bg:'rgba(249,115,22,0.1)', label:'Threat' },
  GALI:           { icon:'🤬', color:'#EAB308', bg:'rgba(234,179,8,0.1)',  label:'Abuse' },
  RUDE_BEHAVIOR:  { icon:'😤', color:'#8B5CF6', bg:'rgba(139,92,246,0.1)', label:'Rude' },
  HARASSMENT:     { icon:'🚨', color:'#3B82F6', bg:'rgba(59,130,246,0.1)', label:'Harassment' },
  GALAT_CHALLAN:  { icon:'📋', color:'#06B6D4', bg:'rgba(6,182,212,0.1)',  label:'Wrong Challan' },
  ANGRY_TONE:     { icon:'🔊', color:'#F59E0B', bg:'rgba(245,158,11,0.1)', label:'Angry Tone' },
  POWER_ABUSE:    { icon:'👊', color:'#A855F7', bg:'rgba(168,85,247,0.1)', label:'Power Abuse' },
  INTIMIDATION:   { icon:'😰', color:'#6366F1', bg:'rgba(99,102,241,0.1)', label:'Intimidation' },
  UNPROFESSIONAL: { icon:'📉', color:'#64748B', bg:'rgba(100,116,139,0.1)',label:'Unprofessional' },
}

// ── Reusable card styles ──
export const C = {
  card:    { background:'#111827', border:'1px solid #1F2937', borderRadius:'16px', padding:'22px' },
  card_sm: { background:'#111827', border:'1px solid #1F2937', borderRadius:'12px', padding:'16px' },
  surface: { background:'#1A1F2E', border:'1px solid #2D3348', borderRadius:'10px', padding:'14px' },
}

export function SeverityBadge({ severity, showIcon = true }) {
  const s = SEV[severity] || SEV.NORMAL
  return (
    <span style={{ background:s.bg, color:s.text, border:`1px solid ${s.border}`,
      padding:'5px 14px', borderRadius:'20px', fontSize:'11px',
      fontWeight:700, letterSpacing:'0.06em', textTransform:'uppercase',
      display:'inline-flex', alignItems:'center', gap:'5px',
      animation: severity === 'CRITICAL' ? 'pulse 2s infinite' : 'none',
      boxShadow: `0 0 12px ${s.glow}` }}>
      {showIcon && <span style={{ fontSize:'11px' }}>{s.icon}</span>}
      {severity}
    </span>
  )
}

export function ScoreRing({ score, severity, size = 100 }) {
  const s    = SEV[severity] || SEV.NORMAL
  const r    = (size - 12) / 2
  const circ = 2 * Math.PI * r
  const off  = circ - (score / 100) * circ
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink:0 }}>
      <defs>
        <filter id={`glow-${severity}`}>
          <feGaussianBlur stdDeviation="3" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="#1F2937" strokeWidth="8"/>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={s.text} strokeWidth="8"
        strokeDasharray={circ} strokeDashoffset={off} strokeLinecap="round"
        transform={`rotate(-90 ${size/2} ${size/2})`}
        filter={`url(#glow-${severity})`}
        style={{ transition:'stroke-dashoffset 1s cubic-bezier(0.4,0,0.2,1)' }}/>
      <text x={size/2} y={size/2-4} textAnchor="middle"
        fill={s.text} fontSize={size > 80 ? 26 : 18} fontWeight="800">{score}</text>
      <text x={size/2} y={size/2+16} textAnchor="middle" fill="#64748B" fontSize="10" fontWeight="600">/100</text>
    </svg>
  )
}

export function ScoreBar({ score, height = 6 }) {
  const color = score >= 70 ? '#EF4444' : score >= 40 ? '#F59E0B' : '#10B981'
  return (
    <div style={{ background:'#1F2937', borderRadius:'4px', overflow:'hidden', height }}>
      <div style={{ height:'100%', width:`${Math.min(score,100)}%`, background:color,
        borderRadius:'4px', transition:'width 0.8s cubic-bezier(0.4,0,0.2,1)',
        boxShadow:`0 0 8px ${color}40` }}/>
    </div>
  )
}

// Plain-English meanings so users understand what each category signals
export const CATEGORY_MEANING = {
  RISHWAT:        'The officer asked for or hinted at money / bribe in exchange for favorable treatment.',
  DHAMKI:         'The officer threatened the civilian with arrest, jail, or harm.',
  GALI:           'The officer used abusive, vulgar, or derogatory words toward the civilian.',
  RUDE_BEHAVIOR:  'The officer spoke in a dismissive, disrespectful, or condescending manner.',
  HARASSMENT:     'The officer personally targeted, intimidated, or pressured the civilian.',
  GALAT_CHALLAN:  'The officer appears to have issued an incorrect or unjustified fine / challan.',
  ANGRY_TONE:     'The officer raised their voice, shouted, or spoke with an aggressive tone.',
  POWER_ABUSE:    'The officer misused their authority or threatened using their official power.',
  INTIMIDATION:   'The officer tried to scare the civilian through indirect threats or warnings.',
  UNPROFESSIONAL: 'The officer spoke carelessly, showed bias, or acted without professional conduct.',
}

export function ViolationCard({ v, index = 0 }) {
  const styles = {
    CRITICAL: { bg:'rgba(239,68,68,0.08)', border:'rgba(239,68,68,0.25)', left:'#EF4444', badge:'#EF4444', text:'#FCA5A5' },
    HIGH:     { bg:'rgba(245,158,11,0.08)', border:'rgba(245,158,11,0.25)', left:'#F59E0B', badge:'#F59E0B', text:'#FCD34D' },
    MEDIUM:   { bg:'rgba(59,130,246,0.08)', border:'rgba(59,130,246,0.25)', left:'#3B82F6', badge:'#3B82F6', text:'#93C5FD' },
    LOW:      { bg:'rgba(100,116,139,0.08)', border:'rgba(100,116,139,0.25)', left:'#64748B', badge:'#64748B', text:'#94A3B8' },
  }
  const s = styles[v.severity] || styles.LOW
  const cat = CATEGORY_STYLE[v.type] || {}
  const meaning = CATEGORY_MEANING[v.type] || ''
  const pct = typeof v.impact_percent === 'number' ? v.impact_percent : v.score
  const label = v.severity_label || `${v.severity || 'LOW'} ${v.severity_index || ''}`.trim()
  return (
    <div className="fade-in" style={{ background:s.bg, border:`1px solid ${s.border}`,
      borderLeft:`4px solid ${s.left}`, borderRadius:'12px', padding:'16px 18px',
      marginBottom:'10px', animationDelay:`${index * 0.06}s`,
      boxShadow: v.severity === 'CRITICAL' ? `0 0 20px rgba(239,68,68,0.1)` : 'none' }}>
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:'12px' }}>
        <div style={{ flex:1 }}>
          <div style={{ display:'flex', alignItems:'center', gap:'8px', marginBottom:'8px', flexWrap:'wrap' }}>
            <span style={{ background:'#0B0F1A', color:'#F1F5F9', fontSize:'11px',
              fontWeight:800, padding:'3px 10px', borderRadius:'6px',
              border:`1px solid ${s.left}55`, letterSpacing:'0.04em' }}>
              Violation {index + 1}
            </span>
            <span style={{ background:s.badge, color:'#fff', fontSize:'10px',
              fontWeight:800, padding:'3px 9px', borderRadius:'4px',
              textTransform:'uppercase', letterSpacing:'0.08em' }}>{label}</span>
            <span style={{ fontSize:'16px' }}>{cat.icon || '●'}</span>
            <span style={{ fontSize:'14px', fontWeight:800, color:'#F1F5F9' }}>
              {(v.label || v.type || '').replace(/_/g,' ')}
            </span>
          </div>
          {meaning && (
            <div style={{ fontSize:'12px', color:'#CBD5E1', lineHeight:1.6,
              marginBottom:'6px' }}>
              <span style={{ color:s.left, fontWeight:700 }}>What this means: </span>
              {meaning}
            </div>
          )}
          <div style={{ fontSize:'12px', color:'#94A3B8', lineHeight:1.6 }}>{v.detail}</div>
          <div style={{ marginTop:'8px', display:'flex', alignItems:'center', gap:'8px' }}>
            <div style={{ flex:1, background:'#1F2937', borderRadius:'4px', overflow:'hidden', height:'5px' }}>
              <div style={{ height:'100%', width:`${Math.min(pct, 100)}%`, background:s.left,
                borderRadius:'4px', transition:'width 0.7s ease' }}/>
            </div>
            <span style={{ fontSize:'10px', fontWeight:700, color:s.left, letterSpacing:'0.04em' }}>
              {pct}% impact
            </span>
          </div>
          {v.keywords_found?.length > 0 && (
            <div style={{ display:'flex', flexWrap:'wrap', gap:'5px', marginTop:'10px' }}>
              {v.keywords_found.map((kw, i) => (
                <span key={i} style={{ background:cat.bg || 'rgba(239,68,68,0.15)',
                  color:cat.color || '#FCA5A5',
                  fontSize:'11px', padding:'4px 10px', borderRadius:'6px',
                  fontWeight:600, border:`1px solid ${(cat.color || '#EF4444')}25` }}>
                  {kw}
                </span>
              ))}
            </div>
          )}
        </div>
        <div style={{ background:`linear-gradient(135deg, ${s.left}, ${s.left}CC)`, color:'#fff',
          fontSize:'14px', fontWeight:800, padding:'8px 12px', borderRadius:'10px',
          whiteSpace:'nowrap', minWidth:'56px', textAlign:'center',
          boxShadow:`0 4px 12px ${s.left}40` }}>
          +{v.score}
        </div>
      </div>
    </div>
  )
}

export function SeverityScale({ totalScore = 0, severity = 'NORMAL', counts = {} }) {
  const bands = [
    { key:'NORMAL',   label:'Normal',   range:'0 – 29%',  color:'#10B981', hint:'No action needed' },
    { key:'WARNING',  label:'Warning',  range:'30 – 69%', color:'#F59E0B', hint:'Flag for supervisor review' },
    { key:'CRITICAL', label:'Critical', range:'70 – 100%', color:'#EF4444', hint:'Immediate investigation' },
  ]
  const pct = Math.max(0, Math.min(100, Number(totalScore) || 0))
  return (
    <div style={{ background:'#111827', border:'1px solid #1F2937', borderRadius:'14px',
      padding:'18px 20px', marginBottom:'14px' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'12px' }}>
        <span style={{ fontSize:'11px', color:'#64748B', textTransform:'uppercase',
          letterSpacing:'0.08em', fontWeight:700 }}>
          🎯 Severity Scale · Total Score
        </span>
        <span style={{ fontSize:'13px', fontWeight:800,
          color: severity === 'CRITICAL' ? '#EF4444' : severity === 'WARNING' ? '#F59E0B' : '#10B981' }}>
          {pct}% · {severity}
        </span>
      </div>
      <div style={{ position:'relative', height:'10px', borderRadius:'6px', overflow:'hidden',
        display:'flex', background:'#0B0F1A' }}>
        <div style={{ width:'30%', background:'#10B981' }}/>
        <div style={{ width:'40%', background:'#F59E0B' }}/>
        <div style={{ width:'30%', background:'#EF4444' }}/>
        <div style={{ position:'absolute', top:'-4px', left:`calc(${pct}% - 9px)`, width:'18px', height:'18px',
          borderRadius:'50%', background:'#fff', border:'3px solid #0B0F1A',
          boxShadow:'0 2px 6px rgba(0,0,0,0.4)' }}/>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:'8px', marginTop:'14px' }}>
        {bands.map(b => {
          const active = severity === b.key
          const count = b.key === 'CRITICAL' ? (counts.CRITICAL || 0)
            : b.key === 'WARNING' ? ((counts.HIGH || 0) + (counts.MEDIUM || 0))
            : (counts.LOW || 0)
          return (
            <div key={b.key} style={{ background: active ? `${b.color}15` : '#0B0F1A',
              border:`1px solid ${active ? b.color + '60' : '#1F2937'}`,
              borderRadius:'10px', padding:'10px 12px' }}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'4px' }}>
                <span style={{ fontSize:'11px', fontWeight:800, color:b.color, letterSpacing:'0.04em' }}>
                  {b.label}
                </span>
                <span style={{ fontSize:'10px', fontWeight:700, color:'#64748B' }}>{b.range}</span>
              </div>
              <div style={{ fontSize:'10px', color:'#94A3B8', lineHeight:1.5, marginBottom:'4px' }}>
                {b.hint}
              </div>
              <div style={{ fontSize:'11px', fontWeight:700, color: count > 0 ? b.color : '#475569' }}>
                {count} violation{count === 1 ? '' : 's'} in this band
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function MetricTile({ label, value, sub, color = '#E2E8F0', icon }) {
  return (
    <div style={{ background:'#111827', border:'1px solid #1F2937', borderRadius:'14px', padding:'18px' }}>
      <div style={{ display:'flex', alignItems:'center', gap:'6px', marginBottom:'10px' }}>
        {icon && <span style={{ fontSize:'14px' }}>{icon}</span>}
        <span style={{ fontSize:'10px', color:'#64748B', textTransform:'uppercase',
          letterSpacing:'0.08em', fontWeight:700 }}>{label}</span>
      </div>
      <div style={{ fontSize:'28px', fontWeight:800, color, marginBottom:'4px' }}>{value}</div>
      {sub && <div style={{ fontSize:'11px', color:'#64748B' }}>{sub}</div>}
    </div>
  )
}

export function ToneBar({ label, prob, percent, active }) {
  const colors = { NORMAL:'#10B981', HARSH:'#EF4444', ANGRY:'#DC2626', BRIBE_TONE:'#F59E0B' }
  const color  = colors[label] || '#64748B'
  // Prefer the backend-provided integer percent (guaranteed to sum to 100). Fall back to prob.
  const pct = typeof percent === 'number' ? percent : Math.round((prob || 0) * 100)
  return (
    <div style={{ background: active ? `${color}15` : '#111827',
      border:`1px solid ${active ? `${color}40` : '#1F2937'}`,
      borderRadius:'10px', padding:'12px 14px',
      boxShadow: active ? `0 0 12px ${color}20` : 'none' }}>
      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:'8px' }}>
        <span style={{ fontSize:'11px', fontWeight:700,
          color:active ? color : '#64748B', textTransform:'uppercase', letterSpacing:'0.05em' }}>
          {label.replace(/_/g,' ')}
        </span>
        <span style={{ fontSize:'15px', fontWeight:800, color:active ? color : '#475569' }}>
          {pct}%
        </span>
      </div>
      <div style={{ background:'#1F2937', borderRadius:'4px', overflow:'hidden', height:'5px' }}>
        <div style={{ height:'100%', width:`${pct}%`, background:color,
          borderRadius:'4px', transition:'width 0.7s ease',
          boxShadow: active ? `0 0 8px ${color}60` : 'none' }}/>
      </div>
    </div>
  )
}

export function Spinner({ size = 18, color = '#3B82F6' }) {
  return (
    <div style={{ width:size, height:size, borderRadius:'50%',
      border:`2px solid #1F2937`, borderTopColor:color,
      animation:'spin 0.7s linear infinite', flexShrink:0 }}/>
  )
}

export function ScoreDisplay({ score, severity }) {
  const s = SEV[severity] || SEV.NORMAL
  return (
    <div style={{ background:s.bg, border:`1px solid ${s.border}`,
      borderRadius:'16px', padding:'24px', display:'flex', alignItems:'center', gap:'24px',
      boxShadow: `0 4px 24px ${s.glow}`,
      animation: severity === 'CRITICAL' ? 'criticalPulse 3s infinite' : 'none' }}>
      <ScoreRing score={score} severity={severity} size={110}/>
      <div style={{ flex:1 }}>
        <SeverityBadge severity={severity}/>
        <div style={{ fontSize:'13px', color:'#94A3B8', marginTop:'10px', marginBottom:'14px', lineHeight:1.6 }}>
          {severity === 'CRITICAL' && 'Immediate action required — supervisor alerted automatically.'}
          {severity === 'WARNING'  && 'Flagged for supervisor review — potential misconduct detected.'}
          {severity === 'NORMAL'   && 'No violations detected — normal enforcement interaction.'}
        </div>
        <ScoreBar score={score}/>
      </div>
    </div>
  )
}

export function ViolationSummary({ violations = [] }) {
  if (!violations.length) return null
  const cats = {}
  violations.forEach(v => {
    const key = v.type || v.label || 'OTHER'
    if (!cats[key]) cats[key] = { count:0, score:0, severity:v.severity, keywords:[] }
    cats[key].count++
    cats[key].score += v.score || 0
    if (v.keywords_found) cats[key].keywords.push(...v.keywords_found)
  })
  return (
    <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(130px, 1fr))', gap:'10px' }}>
      {Object.entries(cats).map(([key, val]) => {
        const cat = CATEGORY_STYLE[key] || { icon:'●', color:'white', bg:'rgba(100,116,139,0.1)' }
        return (
          <div key={key} style={{ background:cat.bg, border:`1px solid ${cat.color}25`,
            borderRadius:'12px', padding:'14px', textAlign:'center',
            boxShadow:`0 0 12px ${cat.color}10` }}>
            <div style={{ fontSize:'22px', marginBottom:'6px' }}>{cat.icon}</div>
            <div style={{ fontSize:'9px', fontWeight:700, color:cat.color,
              textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:'6px' }}>
              {cat.label || key.replace(/_/g,' ')}
            </div>
            <div style={{ fontSize:'20px', fontWeight:800, color:cat.color }}>+{val.score}</div>
            <div style={{ fontSize:'10px', color:'white', marginTop:'3px' }}>
              {val.keywords.length} keyword{val.keywords.length !== 1 ? 's' : ''}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export const MetricCard    = MetricTile
export const ViolationItem = ViolationCard
export const ToneCard      = ToneBar
