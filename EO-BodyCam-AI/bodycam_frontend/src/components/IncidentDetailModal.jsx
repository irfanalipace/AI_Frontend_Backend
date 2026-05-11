import React, { useEffect, useState } from 'react'
import ApiService from '../services/api'

/**
 * IncidentDetailModal — full-fidelity, read-only assessment panel.
 *
 * Shows EVERYTHING the Gemini + acoustic + visual pipeline persisted to
 * MSSQL for a single recording, in a way a supervisor can scan in 5 seconds:
 *
 *   • Hero score + severity + officer + station + timestamp
 *   • Tone mix donut (Normal / Harsh / Angry / Bribe-tone %)
 *   • Acoustic profile (pitch, energy, agitation, loud-duration)
 *   • Voice attribution (EO detected, similarity, time-on-mic)
 *   • Greeting compliance checklist (Salam / Name / Station / Role)
 *   • Emotion vector bars (anger, frustration, intimidation, fear, calm…)
 *   • Visual analysis flags (bribery / aggressive posture / contact / concealed)
 *   • AI assessment + recommended action
 *   • Bilingual transcript (Urdu RTL + English)
 *   • Violations grouped by category (RISHWAT, DHAMKI, GALI, …) with keywords
 *
 * Pure presentation — no analysis logic; only reads .NET DTO fields.
 */

// ── Severity palette ───────────────────────────────────────────────
const SEV = {
  CRITICAL: { color:'#EF4444', bg:'rgba(239,68,68,0.10)',  border:'rgba(239,68,68,0.30)',  glow:'0 0 32px rgba(239,68,68,0.20)' },
  WARNING:  { color:'#F59E0B', bg:'rgba(245,158,11,0.10)', border:'rgba(245,158,11,0.30)', glow:'0 0 32px rgba(245,158,11,0.16)' },
  HIGH:     { color:'#F59E0B', bg:'rgba(245,158,11,0.10)', border:'rgba(245,158,11,0.30)', glow:'0 0 24px rgba(245,158,11,0.15)' },
  MEDIUM:   { color:'#FBBF24', bg:'rgba(251,191,36,0.10)', border:'rgba(251,191,36,0.30)', glow:'0 0 18px rgba(251,191,36,0.12)' },
  NORMAL:   { color:'#10B981', bg:'rgba(16,185,129,0.10)', border:'rgba(16,185,129,0.30)', glow:'0 0 24px rgba(16,185,129,0.16)' },
}

const TONE_COLOR = {
  NORMAL:'#10B981', HARSH:'#F59E0B', ANGRY:'#EF4444',
  BRIBE_TONE:'#8B5CF6', LOUD:'#F59E0B', UNKNOWN:'#64748B',
}

// Friendly labels + colours for the Punjabi / Urdu violation taxonomy.
const VIOLATION_META = {
  RISHWAT:            { label:'Bribe / Rishwat (رشوت)',         color:'#EF4444', icon:'₨' },
  DHAMKI:             { label:'Threat / Dhamki (دھمکی)',         color:'#DC2626', icon:'⚠' },
  GALI:               { label:'Slur / Gali (گالی)',              color:'#B91C1C', icon:'!' },
  POWER_ABUSE:        { label:'Power Abuse',                     color:'#F59E0B', icon:'◈' },
  HARASSMENT:         { label:'Harassment',                      color:'#F97316', icon:'◉' },
  INTIMIDATION:       { label:'Intimidation / Bad-mazi',         color:'#EF4444', icon:'◇' },
  RUDE_BEHAVIOR:      { label:'Rude Behaviour',                  color:'#F59E0B', icon:'◆' },
  ANGRY_TONE:         { label:'Angry Tone',                      color:'#EF4444', icon:'◐' },
  GALAT_CHALLAN:      { label:'Wrong / Fake Challan',            color:'#F59E0B', icon:'✗' },
  UNPROFESSIONAL:     { label:'Unprofessional Conduct',          color:'#FBBF24', icon:'○' },
  PROLONGED_SHOUTING: { label:'Prolonged Shouting',              color:'#EF4444', icon:'♨' },
  HIGH_PITCH:         { label:'Raised Pitch',                    color:'#F59E0B', icon:'⇡' },
  ELEVATED_VOICE:     { label:'Elevated Voice',                  color:'#FBBF24', icon:'⇧' },
  LOUD_VOICE:         { label:'Loud Voice',                      color:'#F59E0B', icon:'♪' },
  BRIBE_TONE:         { label:'Bribe-tone (acoustic)',           color:'#8B5CF6', icon:'$' },
}

const violationMeta = (type) =>
  VIOLATION_META[type] || { label: type || 'Violation', color:'#94A3B8', icon:'•' }

// Transcript field is a JSON-encoded string { urdu, english }.
const parseTranscript = (raw, englishFallback) => {
  if (!raw && !englishFallback) return { urdu:'', english:'' }
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : (raw || {})
    return {
      urdu:    obj.urdu || '',
      english: obj.english || englishFallback || '',
    }
  } catch {
    return { urdu: String(raw || ''), english: englishFallback || '' }
  }
}

// The Python pipeline writes its full snake_case result to RawJson.
// That JSON is the source of truth — it has tone_percents, behavior_assessment,
// keywords_found arrays, severity_counts, greeting suggestions, etc. that the
// flat .NET columns don't expose. Parse it once and merge into a single view
// model, falling back to the flat fields when rawJson is missing (legacy rows).
const parseRawJson = (raw) => {
  if (!raw) return null
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw }
  catch { return null }
}

// ──────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────
export default function IncidentDetailModal({ recordingId, onClose }) {
  const [data, setData] = useState(null)
  const [err,  setErr]  = useState(null)

  // Esc to close + lock background scroll — ONLY while the modal is open.
  // Without this guard, the parent page (Incidents / Video Analysis) keeps
  // <IncidentDetailModal> mounted even when recordingId is null, and the
  // body would stay overflow:hidden forever, breaking page scroll.
  useEffect(() => {
    if (!recordingId) return
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose() }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [recordingId, onClose])

  // Fetch full .NET detail when modal opens / recording changes.
  useEffect(() => {
    if (!recordingId) return
    let cancel = false
    setData(null); setErr(null)
    ApiService.dotnetRecording(recordingId)
      .then(r => { if (!cancel) setData(r.data) })
      .catch(() => { if (!cancel) setErr('Could not load this recording from the database.') })
    return () => { cancel = true }
  }, [recordingId])

  if (!recordingId) return null

  return (
    <div onClick={onClose}
      style={{ position:'fixed', inset:0, zIndex:1000,
        background:'rgba(2,6,23,0.78)',
        backdropFilter:'blur(10px)', WebkitBackdropFilter:'blur(10px)',
        padding:'28px', overflowY:'auto', display:'flex',
        justifyContent:'center', alignItems:'flex-start',
        animation:'fadeIn 0.22s ease-out' }}>
      <div onClick={e => e.stopPropagation()}
        style={{ width:'100%', maxWidth:'1200px',
          background:'linear-gradient(180deg, #0F172A 0%, #0B0F1A 100%)',
          border:'1px solid rgba(51,65,85,0.40)', borderRadius:'20px',
          padding:'28px 30px 32px',
          boxShadow:'0 30px 80px rgba(0,0,0,0.55), 0 1px 0 rgba(255,255,255,0.05) inset',
          animation:'slideUp 0.28s cubic-bezier(0.16, 1, 0.3, 1)',
          color:'#F1F5F9', position:'relative' }}>

        <CloseBtn onClick={onClose}/>

        {!data && !err && <ModalLoading/>}
        {err  && <ModalError message={err}/>}
        {data && <ModalBody rec={data}/>}
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────
// Body — the rich panels.
//
// The Python pipeline's full snake_case JSON is in analysisResult.rawJson.
// We parse it ONCE at the top and use it as the source of truth.  When
// rawJson is missing (older rows from before the schema expansion), we
// fall back to whatever flat columns the .NET DTO does expose, so the
// modal degrades gracefully — sections without data simply hide.
// ──────────────────────────────────────────────────────────────────
function ModalBody({ rec }) {
  const an  = rec.analysisResult || {}
  const r   = parseRawJson(an.rawJson) || {}
  const sev = SEV[an.severity || r.severity] || SEV.NORMAL

  // Violations: prefer the .NET projection (already keyed properly) — but
  // overlay the Python `keywords_found` array onto each one so the UI gets
  // the rich keyword chips that aren't in the DB column.
  const flatViolations = rec.violations || an.violations || []
  const violations = flatViolations.map((v, i) => {
    const py = (r.violations || [])[i] || {}
    return {
      ...v,
      keywords_found:  py.keywords_found || asKeywordsArray(v.keywordsFound),
      impact_percent:  py.impact_percent  ?? v.impactPercent ?? 0,
      severity_label:  py.severity_label  || v.severityLabel,
      detail:          py.detail          || v.detail,
    }
  })

  const tx = parseTranscript(an.transcriptUrdu, an.transcriptEnglish)

  return (
    <>
      <Hero rec={rec} an={an} r={r} sev={sev}/>

      <Grid cols="1.05fr 1fr">
        <ToneMixPanel an={an} r={r}/>
        <AcousticProfilePanel an={an} r={r}/>
      </Grid>

      <Grid cols="1fr 1fr">
        <VoiceAttributionPanel an={an} r={r}/>
        <GreetingCompliancePanel an={an} r={r}/>
      </Grid>

      <ScoreCompositionPanel r={r} an={an}/>

      <SeverityCountsPanel r={r} an={an}/>

      <BehaviorAssessmentPanel r={r}/>

      <AiAssessmentPanel an={an} r={r} violationCount={violations.length}/>

      <EmotionsPanel an={an}/>

      <VisualAnalysisPanel an={an}/>

      <TranscriptPanel tx={tx}
        method={r.transcription_method || an.transcriptionMethod}
        source={r.transcript_source}/>

      <ViolationsPanel violations={violations}/>

      <ProcessingMetaPanel r={r} an={an}/>
    </>
  )
}

// "x, y, z" → ["x", "y", "z"]
function asKeywordsArray(v) {
  if (!v) return []
  if (Array.isArray(v)) return v
  return String(v).split(',').map(s => s.trim()).filter(Boolean)
}

// ── Hero ───────────────────────────────────────────────────────────
function Hero({ rec, an, r, sev }) {
  const toneLabel = an.toneLabel || r.tone_label || 'UNKNOWN'
  const tone      = TONE_COLOR[toneLabel] || '#64748B'
  const totalScore = an.totalScore ?? r.total_score ?? 0
  const toneScore  = an.toneScore  ?? r.tone_score  ?? 0
  const kwScore    = an.kwScore    ?? r.keyword_score ?? 0
  const sevCounts  = r.severity_counts || {}
  const officerName = rec.officerName || r.officer_name || rec.officerId

  return (
    <div style={{ marginBottom:'18px', padding:'22px 24px', borderRadius:'16px',
      background:`linear-gradient(135deg, ${sev.bg}, rgba(255,255,255,0.02))`,
      border:`1px solid ${sev.border}`, boxShadow:sev.glow,
      display:'flex', gap:'22px', alignItems:'center' }}>
      <ScoreRing score={totalScore} severity={an.severity || r.severity} size={120}/>

      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ display:'flex', alignItems:'center', gap:'10px',
          marginBottom:'10px', flexWrap:'wrap' }}>
          <SeverityChip severity={an.severity || r.severity}/>
          <ToneChip tone={toneLabel}
            overallSeverity={(an.severity || r.severity || 'NORMAL').toUpperCase()}/>
          {(an.dominantEmotion || r.behavior_assessment?.overall_rating) && (
            <span style={{ fontSize:'10px', fontWeight:800, color:'#A78BFA',
              padding:'3px 9px', borderRadius:'7px',
              background:'rgba(167,139,250,0.10)',
              border:'1px solid rgba(167,139,250,0.30)',
              textTransform:'uppercase', letterSpacing:'0.06em' }}>
              {an.dominantEmotion || r.behavior_assessment.overall_rating}
            </span>
          )}
          {r.alert_required && (
            <span style={{ fontSize:'10px', fontWeight:800, color:'#EF4444',
              padding:'3px 9px', borderRadius:'7px',
              background:'rgba(239,68,68,0.12)',
              border:'1px solid rgba(239,68,68,0.35)',
              textTransform:'uppercase', letterSpacing:'0.06em' }}>
              ⚠ Alert Required
            </span>
          )}
        </div>

        <div style={{ fontSize:'19px', fontWeight:800, color:'#F1F5F9',
          marginBottom:'5px', letterSpacing:'-0.01em',
          overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
          {rec.filename || r.filename}
        </div>

        <div style={{ fontSize:'12px', color:'#94A3B8',
          display:'flex', flexWrap:'wrap', gap:'8px 16px' }}>
          <span>◎ Officer: <strong style={{ color:'#F1F5F9' }}>
            {officerName}</strong></span>
          <span>· {rec.stationId || r.source || 'unknown station'}</span>
          <span>· {new Date(rec.uploadedAt || r.timestamp).toLocaleString()}</span>
          {(rec.mediaType || r.media_type) && (
            <span>· {rec.mediaType || r.media_type}</span>
          )}
          {r.total_duration_sec > 0 && (
            <span>· {formatDuration(r.total_duration_sec)}</span>
          )}
        </div>

        <div style={{ display:'flex', gap:'10px', marginTop:'14px',
          fontSize:'11px', flexWrap:'wrap' }}>
          <Stat label="Total"     val={totalScore}  c={sev.color}/>
          <Stat label="Tone"      val={toneScore}   c={tone}/>
          <Stat label="Keywords"  val={kwScore}     c="#8B5CF6"/>
          <Stat label="Critical"  val={sevCounts.CRITICAL ?? an.criticalCount ?? 0} c="#EF4444"/>
          <Stat label="High"      val={sevCounts.HIGH     ?? an.highCount     ?? 0} c="#F59E0B"/>
          <Stat label="Medium"    val={sevCounts.MEDIUM   ?? an.mediumCount   ?? 0} c="#FBBF24"/>
          {sevCounts.LOW != null && <Stat label="Low" val={sevCounts.LOW} c="#10B981"/>}
        </div>
      </div>
    </div>
  )
}

const formatDuration = (sec) => {
  const s = Math.round(sec)
  const m = Math.floor(s / 60)
  const ss = String(s % 60).padStart(2, '0')
  return `${m}:${ss} min`
}

// ── Tone mix donut + legend ────────────────────────────────────────
// Reads from rawJson.tone_percents first (the source of truth — Python
// classifier output), falling back to the flat .NET columns.
function ToneMixPanel({ an, r }) {
  const tp = r.tone_percents || {}
  const slices = [
    { key:'NORMAL',     val: pctNum(tp.NORMAL     ?? an.tonePercentNormal), color: TONE_COLOR.NORMAL },
    { key:'HARSH',      val: pctNum(tp.HARSH      ?? an.tonePercentHarsh),  color: TONE_COLOR.HARSH },
    { key:'ANGRY',      val: pctNum(tp.ANGRY      ?? an.tonePercentAngry),  color: TONE_COLOR.ANGRY },
    { key:'BRIBE_TONE', val: pctNum(tp.BRIBE_TONE ?? an.tonePercentBribe),  color: TONE_COLOR.BRIBE_TONE },
  ].filter(s => s.val > 0)

  const total = slices.reduce((a, s) => a + s.val, 0) || 0
  const dominantTone = an.toneLabel || r.tone_label || 'TONE'

  return (
    <PanelCard title="Tone Mix" subtitle="Per-window SVM classifier output">
      {total === 0 ? (
        <Empty>No per-window tone breakdown available for this recording.</Empty>
      ) : (
        <div style={{ display:'flex', alignItems:'center', gap:'18px' }}>
          <Donut slices={slices} size={140}
            centerLabel={dominantTone}
            centerColor={TONE_COLOR[dominantTone] || '#94A3B8'}/>
          <div style={{ flex:1, display:'flex', flexDirection:'column', gap:'8px' }}>
            {slices.map(s => (
              <div key={s.key} style={{ display:'flex', alignItems:'center', gap:'10px' }}>
                <span style={{ width:10, height:10, borderRadius:'3px',
                  background:s.color, boxShadow:`0 0 10px ${s.color}80` }}/>
                <span style={{ fontSize:'11px', fontWeight:700, color:'#F1F5F9',
                  flex:1, letterSpacing:'0.04em' }}>{s.key.replace('_',' ')}</span>
                <span style={{ fontSize:'12px', fontWeight:800, color:s.color,
                  fontVariantNumeric:'tabular-nums' }}>
                  {s.val.toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </PanelCard>
  )
}

// ── Acoustic profile ──────────────────────────────────────────────
function AcousticProfilePanel({ an, r }) {
  const a = r.acoustics || {}
  const avgPitch    = num(a.avg_pitch_hz       ?? an.avgPitchHz)
  const baseline    = num(a.enrolled_pitch_hz  ?? an.baselinePitchHz)
  const pitchRatio  = num(a.pitch_ratio        ?? an.pitchRatio)
  const energy      = num(a.avg_energy         ?? an.avgEnergy)
  // Python writes agitation as ~0–5 raw; flat .NET column is normalised 0–1.
  // Map both to a 0–10 visual scale for the bar.
  const agitationRaw = num(a.agitation         ?? an.agitation)
  const loud         = num(a.loud_duration_sec ?? an.loudDurationSec)

  return (
    <PanelCard title="Acoustic Profile" subtitle="Pitch · Energy · Agitation · librosa">
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'10px' }}>
        <Metric label="Avg Pitch"
          val={`${avgPitch.toFixed(0)} Hz`}
          sub={baseline > 0 ? `Baseline ${baseline.toFixed(0)} Hz` : '—'}
          color={pitchRatio > 1.4 ? '#EF4444' : pitchRatio > 1.15 ? '#F59E0B' : '#10B981'}/>
        <Metric label="Pitch Ratio"
          val={`${pitchRatio.toFixed(2)}×`}
          sub={pitchRatio > 1.4 ? 'Sharply raised' : pitchRatio > 1.15 ? 'Raised' : 'Normal'}
          color={pitchRatio > 1.4 ? '#EF4444' : pitchRatio > 1.15 ? '#F59E0B' : '#10B981'}/>
        <Metric label="Avg Energy"
          val={energy.toFixed(3)}
          sub={energy > 0.18 ? 'Loud delivery' : energy > 0.08 ? 'Elevated' : 'Calm'}
          color={energy > 0.18 ? '#EF4444' : energy > 0.08 ? '#F59E0B' : '#10B981'}/>
        <Metric label="Loud Duration"
          val={`${loud.toFixed(0)} s`}
          sub={loud > 60 ? 'Sustained' : loud > 15 ? 'Burst' : 'Brief / none'}
          color={loud > 60 ? '#EF4444' : loud > 15 ? '#F59E0B' : '#10B981'}/>
      </div>

      <div style={{ marginTop:'14px' }}>
        <BarMeter label={`Agitation index (${agitationRaw.toFixed(2)})`}
          value={Math.min(agitationRaw, 5)} max={5}
          color={agitationRaw > 2 ? '#EF4444' : agitationRaw > 1 ? '#F59E0B' : '#10B981'}/>
      </div>
    </PanelCard>
  )
}

// ── Voice attribution (Officer vs Citizen) ────────────────────────
function VoiceAttributionPanel({ an, r }) {
  const dia = r.diarization || {}
  const eoSec    = num(dia.eo_total_sec       ?? an.eoTotalSec)
  const custSec  = num(dia.customer_total_sec ?? an.customerTotalSec)
  const total    = eoSec + custSec
  const eoPct    = total > 0 ? (eoSec / total) * 100 : 0
  const sim      = num(an.eoSimilarity ?? r.max_similarity)
  const avgSim   = num(r.avg_similarity)
  const detected = an.eoDetected ?? r.eo_detected
  const speakers = dia.speaker_count ?? an.speakerCount ?? 0
  const eoSegs   = dia.eo_segments_count       ?? an.eoSegmentsCount       ?? 0
  const cuSegs   = dia.customer_segments_count ?? an.customerSegmentsCount ?? 0

  return (
    <PanelCard title="Voice Attribution"
      subtitle={`${speakers} speakers · diarised · 0.82 voiceprint threshold`}>
      <div style={{ display:'flex', alignItems:'center', gap:'10px',
        marginBottom:'12px', flexWrap:'wrap' }}>
        <span style={{ fontSize:'11px', fontWeight:800, padding:'4px 10px',
          borderRadius:'7px', textTransform:'uppercase', letterSpacing:'0.06em',
          background: detected ? 'rgba(16,185,129,0.10)' : 'rgba(239,68,68,0.10)',
          color:     detected ? '#10B981' : '#EF4444',
          border:`1px solid ${detected ? 'rgba(16,185,129,0.30)' : 'rgba(239,68,68,0.30)'}` }}>
          {detected ? '✓ EO Detected' : '✗ EO Not Detected'}
        </span>
        {sim > 0 && (
          <span style={{ fontSize:'10px', color:'#94A3B8' }}>
            best match <strong style={{ color:'#F1F5F9' }}>{(sim * 100).toFixed(1)}%</strong>
            {avgSim > 0 && <> · avg <strong style={{ color:'#F1F5F9' }}>
              {(avgSim * 100).toFixed(1)}%</strong></>}
          </span>
        )}
      </div>

      <BarMeter label={`Officer speaking (${eoSec.toFixed(0)}s)`}
        value={eoPct} max={100} color="#3B82F6" suffix="%"/>
      <BarMeter label={`Citizen speaking (${custSec.toFixed(0)}s)`}
        value={total > 0 ? 100 - eoPct : 0} max={100} color="#A78BFA" suffix="%"/>

      <div style={{ display:'flex', gap:'12px', marginTop:'12px',
        fontSize:'10px', color:'#64748B' }}>
        <span>EO segments: <strong style={{ color:'#F1F5F9' }}>
          {eoSegs}</strong></span>
        <span>· Citizen segments: <strong style={{ color:'#F1F5F9' }}>
          {cuSegs}</strong></span>
      </div>
    </PanelCard>
  )
}

// ── Greeting compliance ───────────────────────────────────────────
function GreetingCompliancePanel({ an, r }) {
  const g = r.greeting || {}
  const salam   = g.salam_found       ?? an.salamFound
  const nameOk  = g.name_introduced   ?? an.nameIntroduced
  const station = g.station_mentioned ?? an.stationMentioned
  const role    = g.role_mentioned    ?? an.roleMentioned
  const score   = num(g.greeting_score ?? an.greetingScore)
  const compliance = g.greeting_compliance || an.greetingCompliance || 'not assessed'
  const xname    = g.extracted_name    || an.extractedName
  const xstation = g.extracted_station || an.extractedStation
  const suggestions = Array.isArray(g.suggestions) ? g.suggestions : []

  const items = [
    { ok: !!salam,   label:'Greeting (Salam / Adaab)' },
    { ok: !!nameOk,  label:`Name introduced${xname ? ` — ${xname}` : ''}` },
    { ok: !!station, label:`Station mentioned${xstation ? ` — ${xstation}` : ''}` },
    { ok: !!role,    label:'Role / Department mentioned' },
  ]

  return (
    <PanelCard title="Greeting Compliance"
      subtitle="Optional · informational only — does NOT count as a violation">
      <div style={{ display:'flex', alignItems:'center', gap:'12px',
        marginBottom:'12px' }}>
        <div style={{ fontSize:'24px', fontWeight:900, color: score >= 75
          ? '#10B981' : score >= 40 ? '#F59E0B' : '#64748B',
          letterSpacing:'-0.02em' }}>{score.toFixed(0)}</div>
        <div style={{ fontSize:'11px', color:'#94A3B8' }}>
          / 100 compliance score<br/>
          <span style={{ fontSize:'10px', color:'#64748B' }}>{compliance}</span>
        </div>
      </div>

      {items.map((it, i) => (
        <div key={i} style={{ display:'flex', alignItems:'center', gap:'10px',
          padding:'7px 10px', marginBottom:'5px', borderRadius:'8px',
          background: it.ok ? 'rgba(16,185,129,0.06)' : 'rgba(255,255,255,0.02)',
          border:`1px solid ${it.ok ? 'rgba(16,185,129,0.20)' : '#1F2937'}` }}>
          <span style={{ width:18, height:18, borderRadius:'50%',
            background: it.ok ? 'rgba(16,185,129,0.15)' : 'rgba(100,116,139,0.10)',
            border:`1px solid ${it.ok ? 'rgba(16,185,129,0.40)' : '#334155'}`,
            color: it.ok ? '#10B981' : '#475569',
            display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:'10px', fontWeight:900 }}>{it.ok ? '✓' : '○'}</span>
          <span style={{ fontSize:'12px',
            color: it.ok ? '#F1F5F9' : '#94A3B8',
            fontWeight: it.ok ? 600 : 500 }}>{it.label}</span>
        </div>
      ))}

      {suggestions.length > 0 && (
        <div style={{ marginTop:'12px', padding:'10px 12px', borderRadius:'8px',
          background:'rgba(59,130,246,0.06)',
          border:'1px solid rgba(59,130,246,0.20)',
          borderLeft:'3px solid #3B82F6' }}>
          <div style={{ fontSize:'9px', color:'#60A5FA', fontWeight:800,
            letterSpacing:'0.10em', textTransform:'uppercase',
            marginBottom:'6px' }}>
            Suggestions for the officer
          </div>
          {suggestions.map((s, i) => (
            <div key={i} style={{ fontSize:'11px', color:'#CBD5E1',
              lineHeight:1.55, marginBottom:'3px' }}>· {s}</div>
          ))}
        </div>
      )}
    </PanelCard>
  )
}

// ── Emotion vector bars ───────────────────────────────────────────
function EmotionsPanel({ an }) {
  const rows = [
    ['Anger',         num(an.emotionAnger),        '#EF4444'],
    ['Frustration',   num(an.emotionFrustration),  '#F97316'],
    ['Contempt',      num(an.emotionContempt),     '#EC4899'],
    ['Intimidation',  num(an.emotionIntimidation), '#DC2626'],
    ['Fear (citizen)', num(an.emotionFear),        '#A78BFA'],
    ['Agitation',     num(an.emotionAgitation),    '#F59E0B'],
    ['Calm',          num(an.emotionCalm),         '#10B981'],
    ['Neutral',       num(an.emotionNeutral),      '#64748B'],
  ].filter(([, v]) => v > 0)

  if (rows.length === 0) return null

  return (
    <PanelCard title="Emotion Vector"
      subtitle={an.emotionNarrative || 'Per-emotion intensity from Gemini multimodal'}>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr',
        columnGap:'18px' }}>
        {rows.map(([label, v, c]) => (
          <BarMeter key={label} label={label} value={v * 100} max={100}
            color={c} suffix="%"/>
        ))}
      </div>
    </PanelCard>
  )
}

// ── Visual analysis flags ─────────────────────────────────────────
function VisualAnalysisPanel({ an }) {
  const status = (an.visualAnalysisStatus || '').toString()
  const flags = [
    { key:'briberyVisualDetected',     label:'Bribery exchange',      icon:'₨' },
    { key:'aggressivePostureDetected', label:'Aggressive posture',    icon:'⚡' },
    { key:'physicalContactDetected',   label:'Physical contact',      icon:'✊' },
    { key:'concealedGesturesDetected', label:'Concealed gestures',    icon:'◐' },
  ]

  // If everything is false AND there's no risk score AND no summary, hide
  // the panel entirely — frequent on audio-only or low-quality clips.
  const anyFlag = flags.some(f => an[f.key])
  const risk = num(an.visualRiskScore)
  if (!anyFlag && !risk && !an.visualSummary) return null

  return (
    <PanelCard title="Visual Analysis"
      subtitle={status ? `Gemini vision · ${status}` : 'Gemini vision'}>
      {risk > 0 && (
        <div style={{ marginBottom:'12px' }}>
          <BarMeter label="Visual risk score" value={risk} max={100}
            color={risk >= 70 ? '#EF4444' : risk >= 40 ? '#F59E0B' : '#10B981'}
            suffix="/100"/>
        </div>
      )}

      <div style={{ display:'grid', gridTemplateColumns:'repeat(2, 1fr)',
        gap:'8px', marginBottom: an.visualSummary ? '12px' : 0 }}>
        {flags.map(f => {
          const triggered = !!an[f.key]
          return (
            <div key={f.key} style={{ display:'flex', alignItems:'center',
              gap:'10px', padding:'10px 12px', borderRadius:'10px',
              background: triggered ? 'rgba(239,68,68,0.08)' : 'rgba(255,255,255,0.02)',
              border:`1px solid ${triggered ? 'rgba(239,68,68,0.30)' : '#1F2937'}` }}>
              <span style={{ width:30, height:30, borderRadius:'8px',
                background: triggered ? 'rgba(239,68,68,0.15)' : 'rgba(255,255,255,0.04)',
                color: triggered ? '#EF4444' : '#475569',
                display:'flex', alignItems:'center', justifyContent:'center',
                fontSize:'14px', fontWeight:800 }}>{f.icon}</span>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:'12px', fontWeight:700,
                  color: triggered ? '#F1F5F9' : '#94A3B8' }}>{f.label}</div>
                <div style={{ fontSize:'10px',
                  color: triggered ? '#EF4444' : '#475569',
                  fontWeight:700, letterSpacing:'0.04em',
                  textTransform:'uppercase' }}>
                  {triggered ? 'DETECTED' : 'clear'}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {an.visualSummary && (
        <div style={{ fontSize:'12px', color:'#CBD5E1', lineHeight:1.6,
          padding:'10px 12px', borderRadius:'8px',
          background:'rgba(0,0,0,0.25)', borderLeft:'3px solid #8B5CF6' }}>
          {an.visualSummary}
        </div>
      )}
    </PanelCard>
  )
}

// ── AI Assessment + recommended action ────────────────────────────
function AiAssessmentPanel({ an, r, violationCount }) {
  const assessment = r.ai_assessment || an.aiAssessment
  const ba = r.behavior_assessment || {}
  const action = ba.recommendation || an.recommendedAction
  if (!assessment && !action) return null

  return (
    <PanelCard title="Gemini Officer Assessment"
      subtitle="Multimodal review of the officer's conduct">
      {assessment && (
        <div style={{ fontSize:'13px', color:'#F1F5F9', lineHeight:1.75,
          padding:'14px 16px', borderRadius:'10px',
          background:'rgba(59,130,246,0.06)',
          border:'1px solid rgba(59,130,246,0.20)',
          borderLeft:'3px solid #3B82F6', marginBottom:'10px' }}>
          {assessment}
        </div>
      )}
      {action && (
        <div style={{ display:'flex', gap:'12px', alignItems:'flex-start',
          padding:'12px 14px', borderRadius:'10px',
          background:'rgba(245,158,11,0.06)',
          border:'1px solid rgba(245,158,11,0.20)',
          borderLeft:'3px solid #F59E0B' }}>
          <div style={{ fontSize:'9px', color:'#F59E0B', fontWeight:800,
            letterSpacing:'0.10em', minWidth:'82px',
            textTransform:'uppercase', paddingTop:'2px' }}>
            Recommended<br/>Action
          </div>
          <div style={{ fontSize:'13px', color:'#FDE68A',
            fontWeight:700, lineHeight:1.6 }}>
            {action}
          </div>
        </div>
      )}
      <div style={{ marginTop:'10px', fontSize:'10px', color:'#64748B' }}>
        Based on {violationCount} violation{violationCount === 1 ? '' : 's'} ·
        confidence is informational, not legal evidence.
      </div>
    </PanelCard>
  )
}

// ── Behavior Assessment (overall rating + flags) ──────────────────
// rawJson.behavior_assessment is populated by Python when Gemini provides
// an overall rating, recommendation, and an array of behaviour flags.
// e.g. { overall_rating:'SEVERE_MISCONDUCT', recommendation:'SUSPEND...',
//        behavior_flags:['...', '...'], violation_summary:{RISHWAT:1,...} }
function BehaviorAssessmentPanel({ r }) {
  const ba = r.behavior_assessment
  if (!ba) return null
  const flags   = Array.isArray(ba.behavior_flags) ? ba.behavior_flags : []
  const summary = ba.violation_summary || {}
  const rating  = ba.overall_rating

  // Map ratings to severity colours so the panel feels consistent.
  const ratingColor =
    /SEVERE|MAJOR|CRITICAL/i.test(rating || '') ? '#EF4444'
    : /MODERATE|WARNING/i.test(rating || '')   ? '#F59E0B'
    : /MINOR|LOW|NORMAL/i.test(rating || '')   ? '#10B981'
    : '#3B82F6'

  return (
    <PanelCard title="Behavior Assessment"
      subtitle="Overall conduct rating · derived flags · category counts">
      {rating && (
        <div style={{ display:'inline-flex', alignItems:'center', gap:'10px',
          padding:'8px 14px', borderRadius:'10px', marginBottom:'14px',
          background:`${ratingColor}15`, border:`1px solid ${ratingColor}40`,
          boxShadow:`0 0 16px ${ratingColor}30` }}>
          <span style={{ fontSize:'9px', color:'#94A3B8', fontWeight:700,
            letterSpacing:'0.10em', textTransform:'uppercase' }}>
            Overall Rating
          </span>
          <span style={{ fontSize:'14px', fontWeight:900, color: ratingColor,
            letterSpacing:'-0.01em' }}>
            {rating.replace(/_/g, ' ')}
          </span>
        </div>
      )}

      {flags.length > 0 && (
        <div style={{ marginBottom:'14px' }}>
          <div style={{ fontSize:'9px', color:'#64748B', fontWeight:800,
            letterSpacing:'0.10em', textTransform:'uppercase',
            marginBottom:'8px' }}>
            Flags raised by the system
          </div>
          {flags.map((f, i) => (
            <div key={i} style={{ display:'flex', alignItems:'flex-start',
              gap:'10px', padding:'9px 12px', marginBottom:'6px',
              borderRadius:'9px',
              background:'rgba(239,68,68,0.05)',
              border:'1px solid rgba(239,68,68,0.20)',
              borderLeft:'3px solid #EF4444' }}>
              <span style={{ color:'#EF4444', fontSize:'12px',
                fontWeight:900, lineHeight:1.5 }}>!</span>
              <span style={{ fontSize:'12px', color:'#FCA5A5',
                fontWeight:600, lineHeight:1.5 }}>{f}</span>
            </div>
          ))}
        </div>
      )}

      {Object.keys(summary).length > 0 && (
        <div>
          <div style={{ fontSize:'9px', color:'#64748B', fontWeight:800,
            letterSpacing:'0.10em', textTransform:'uppercase',
            marginBottom:'8px' }}>
            Violations by category
          </div>
          <div style={{ display:'flex', flexWrap:'wrap', gap:'7px' }}>
            {Object.entries(summary).map(([type, count]) => {
              const meta = violationMeta(type)
              return (
                <span key={type} style={{ display:'inline-flex',
                  alignItems:'center', gap:'8px',
                  padding:'5px 12px', borderRadius:'8px',
                  fontSize:'11px', fontWeight:800,
                  background:`${meta.color}15`, color:meta.color,
                  border:`1px solid ${meta.color}40` }}>
                  <span style={{ fontSize:'13px' }}>{meta.icon}</span>
                  {type}
                  <span style={{ background:`${meta.color}25`,
                    padding:'1px 7px', borderRadius:'5px',
                    fontSize:'10px', fontWeight:900 }}>{count}</span>
                </span>
              )
            })}
          </div>
        </div>
      )}
    </PanelCard>
  )
}

// ── Score Composition (explains tone-vs-severity mismatch) ────────
// The card shows "ANGRY" tone but "NORMAL" severity, which can read as
// contradictory. This panel makes the math explicit:
//   tone_score (per-window classifier) + keyword_score (transcript match)
//   = total_score → maps to a band (NORMAL/WARNING/CRITICAL).
// The tone *label* and *severity band* are independent — voice can sound
// angry without abusive language, which is exactly NORMAL severity.
function ScoreCompositionPanel({ r, an }) {
  const tone = num(r.tone_score    ?? an.toneScore)
  const kw   = num(r.keyword_score ?? an.kwScore)
  const total = num(r.total_score  ?? an.totalScore)
  const sevName = (an.severity || r.severity || 'NORMAL').toUpperCase()
  const sev = SEV[sevName] || SEV.NORMAL
  const toneLabel = an.toneLabel || r.tone_label || '—'

  // Severity bands come from rawJson when available; fall back to defaults.
  const bandsObj = r.severity_bands || {
    NORMAL:   { min: 0,  max: 29,  label: 'Normal (0–29)'   },
    WARNING:  { min: 30, max: 69,  label: 'Warning (30–69)' },
    CRITICAL: { min: 70, max: 100, label: 'Critical (70–100)' },
  }
  const bands = ['NORMAL', 'WARNING', 'CRITICAL']
    .filter(k => bandsObj[k])
    .map(k => ({ key: k, ...bandsObj[k], color: SEV[k]?.color || '#94A3B8' }))

  const showTonality =
    /ANGRY|HARSH|BRIBE/.test(toneLabel) && sevName === 'NORMAL'

  return (
    <PanelCard title="Score Composition"
      subtitle="How the total score was built and why this severity was chosen">

      {/* Equation: tone + keywords = total */}
      <div style={{ display:'flex', alignItems:'stretch', gap:'10px',
        marginBottom:'14px', flexWrap:'wrap' }}>
        <ScoreBlock label="Tone Score"    value={tone}  color="#A78BFA"
          subtitle="From SVM per-window classifier"/>
        <Operator>+</Operator>
        <ScoreBlock label="Keyword Score" value={kw}    color="#F59E0B"
          subtitle="From transcript keyword match"/>
        <Operator>=</Operator>
        <ScoreBlock label="Total Score"   value={total} color={sev.color}
          subtitle={`→ ${sevName} band`} highlight/>
      </div>

      {/* Band ladder — the score's position visualised */}
      <div style={{ marginBottom: showTonality ? '14px' : 0 }}>
        <div style={{ fontSize:'9px', color:'#64748B', fontWeight:800,
          letterSpacing:'0.10em', textTransform:'uppercase',
          marginBottom:'8px' }}>Severity Bands</div>
        <div style={{ position:'relative', height:'34px',
          background:'rgba(255,255,255,0.03)', borderRadius:'8px',
          overflow:'hidden', border:'1px solid #1F2937', display:'flex' }}>
          {bands.map(b => {
            const width = (b.max - b.min + 1)
            const inThisBand = total >= b.min && total <= b.max
            return (
              <div key={b.key}
                style={{ flex: width, position:'relative',
                  background: inThisBand
                    ? `linear-gradient(90deg, ${b.color}30, ${b.color}50)`
                    : `${b.color}10`,
                  borderRight: '1px solid rgba(255,255,255,0.04)',
                  display:'flex', alignItems:'center',
                  justifyContent:'center',
                  fontSize:'10px', fontWeight:800,
                  color: inThisBand ? b.color : '#475569',
                  letterSpacing:'0.08em' }}>
                {b.key}
                <span style={{ fontSize:'9px', color: inThisBand ? b.color : '#334155',
                  marginLeft:'6px', fontWeight:600 }}>
                  {b.min}–{b.max}
                </span>
              </div>
            )
          })}
          {/* Score marker */}
          <div style={{
            position:'absolute', top:0, bottom:0,
            left:`${Math.min(99, Math.max(0, total))}%`,
            width:'2px', background: sev.color,
            boxShadow:`0 0 10px ${sev.color}`,
            transition:'left 0.6s ease' }}/>
          <div style={{
            position:'absolute', top:'-3px',
            left:`${Math.min(99, Math.max(0, total))}%`,
            transform:'translateX(-50%)',
            fontSize:'9px', fontWeight:900,
            color: sev.color,
            background:'#0B0F1A',
            padding:'1px 5px', borderRadius:'4px',
            border:`1px solid ${sev.color}` }}>
            {total}
          </div>
        </div>
      </div>

      {/* Explainer when tone label looks scarier than the severity */}
      {showTonality && (
        <div style={{ padding:'11px 14px', borderRadius:'9px',
          background:'rgba(59,130,246,0.06)',
          border:'1px solid rgba(59,130,246,0.20)',
          borderLeft:'3px solid #3B82F6',
          fontSize:'12px', color:'#CBD5E1', lineHeight:1.65 }}>
          <strong style={{ color:'#60A5FA' }}>Why is severity NORMAL when tone is {toneLabel}?</strong>
          <br/>
          The SVM classified the officer's voice as <strong>{toneLabel}</strong> across most
          windows, but the <strong>total score is only {total}/100</strong> because
          {kw === 0 ? <> no abusive / bribe / threat keywords were detected in the transcript</>
                    : <> the keyword evidence was limited</>}.
          {' '}A NORMAL band ({bandsObj.NORMAL?.min ?? 0}–{bandsObj.NORMAL?.max ?? 29})
          means <em>"voice sounded raised, but no documented misconduct"</em>.
        </div>
      )}
    </PanelCard>
  )
}

// Inline helpers used by ScoreCompositionPanel
function ScoreBlock({ label, value, color, subtitle, highlight }) {
  return (
    <div style={{ flex:1, minWidth:'100px',
      padding:'12px 14px', borderRadius:'10px',
      background: highlight
        ? `linear-gradient(135deg, ${color}18, rgba(255,255,255,0.02))`
        : 'rgba(0,0,0,0.20)',
      border:`1px solid ${highlight ? color + '50' : '#1F2937'}`,
      boxShadow: highlight ? `0 0 18px ${color}25` : 'none' }}>
      <div style={{ fontSize:'9px', color:'#64748B', fontWeight:800,
        letterSpacing:'0.08em', textTransform:'uppercase',
        marginBottom:'4px' }}>{label}</div>
      <div style={{ fontSize:'24px', fontWeight:900, color,
        letterSpacing:'-0.02em', lineHeight:1,
        fontVariantNumeric:'tabular-nums' }}>{value}</div>
      {subtitle && (
        <div style={{ fontSize:'10px', color:'#94A3B8',
          marginTop:'4px', fontWeight:500 }}>{subtitle}</div>
      )}
    </div>
  )
}

function Operator({ children }) {
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center',
      width:'24px', fontSize:'18px', fontWeight:300, color:'#475569' }}>
      {children}
    </div>
  )
}

// ── Severity Counts (CRITICAL / HIGH / MEDIUM / LOW) ──────────────
// Comes from rawJson.severity_counts. Useful at-a-glance breakdown
// of how the violations stack up by severity tier.
function SeverityCountsPanel({ r, an }) {
  const counts = r.severity_counts || {}
  const total = counts.TOTAL ?? null
  if (total == null && !an.criticalCount && !an.highCount && !an.mediumCount) {
    return null
  }
  const tiers = [
    { key:'CRITICAL', val: counts.CRITICAL ?? an.criticalCount ?? 0, color:'#EF4444' },
    { key:'HIGH',     val: counts.HIGH     ?? an.highCount     ?? 0, color:'#F59E0B' },
    { key:'MEDIUM',   val: counts.MEDIUM   ?? an.mediumCount   ?? 0, color:'#FBBF24' },
    { key:'LOW',      val: counts.LOW      ?? 0,                     color:'#10B981' },
  ]
  const max = Math.max(1, ...tiers.map(t => t.val))

  return (
    <PanelCard title="Severity Distribution"
      subtitle={`${total ?? tiers.reduce((a, t) => a + t.val, 0)} total violations across 4 tiers`}>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)',
        gap:'10px' }}>
        {tiers.map(t => (
          <div key={t.key} style={{ padding:'14px 14px',
            borderRadius:'12px',
            background:`linear-gradient(135deg, ${t.color}10, rgba(255,255,255,0.02))`,
            border:`1px solid ${t.color}30` }}>
            <div style={{ fontSize:'9px', color:'#64748B', fontWeight:800,
              letterSpacing:'0.10em', textTransform:'uppercase' }}>{t.key}</div>
            <div style={{ fontSize:'24px', fontWeight:900, color:t.color,
              marginTop:'4px', letterSpacing:'-0.02em',
              fontVariantNumeric:'tabular-nums', lineHeight:1 }}>{t.val}</div>
            <div style={{ height:'4px', borderRadius:'2px',
              background:'rgba(255,255,255,0.05)', marginTop:'8px',
              overflow:'hidden' }}>
              <div style={{ width:`${(t.val / max) * 100}%`,
                height:'100%', background:t.color,
                boxShadow:`0 0 8px ${t.color}AA`,
                borderRadius:'2px',
                transition:'width 0.6s ease' }}/>
            </div>
          </div>
        ))}
      </div>
    </PanelCard>
  )
}

// ── Processing metadata (small footer panel) ──────────────────────
function ProcessingMetaPanel({ r, an }) {
  const items = [
    ['Score Source',         r.score_source],
    ['Transcription',        r.transcription_method || an.transcriptionMethod],
    ['Processing Time',      r.processing_time_sec ? `${num(r.processing_time_sec).toFixed(0)}s` : null],
    ['Speech Segments',      r.speech_segments],
    ['Heuristic Severity',   r.heuristic_severity],
    ['Heuristic Score',      r.heuristic_total_score],
    ['Incident ID',          r.incident_id],
  ].filter(([_, v]) => v != null && v !== '')

  if (items.length === 0) return null

  return (
    <PanelCard title="Processing Metadata"
      subtitle="Pipeline diagnostics for this analysis run">
      <div style={{ display:'grid',
        gridTemplateColumns:'repeat(auto-fit, minmax(160px, 1fr))',
        gap:'8px' }}>
        {items.map(([label, val]) => (
          <div key={label} style={{ padding:'9px 12px', borderRadius:'8px',
            background:'rgba(0,0,0,0.20)', border:'1px solid #1F2937' }}>
            <div style={{ fontSize:'9px', color:'#64748B', fontWeight:700,
              letterSpacing:'0.08em', textTransform:'uppercase',
              marginBottom:'3px' }}>{label}</div>
            <div style={{ fontSize:'12px', color:'#F1F5F9',
              fontWeight:700, fontFamily:'ui-monospace, monospace',
              wordBreak:'break-word' }}>{String(val)}</div>
          </div>
        ))}
      </div>
    </PanelCard>
  )
}

// ── Bilingual transcript ──────────────────────────────────────────
// Header shows WHICH engine produced the transcript — Whisper (local) or
// Gemini 2.5 Flash (multimodal). Helpful for supervisors auditing accuracy.
function TranscriptPanel({ tx, method, source }) {
  if (!tx.urdu && !tx.english) return null
  const engine = describeEngine(method)

  return (
    <PanelCard title="Transcript" subtitle="Bilingual auto-transcription">
      {/* Engine badge row */}
      <div style={{ display:'flex', alignItems:'center', gap:'8px',
        marginBottom:'12px', flexWrap:'wrap' }}>
        <span style={{ fontSize:'9px', color:'#64748B', fontWeight:800,
          letterSpacing:'0.10em', textTransform:'uppercase' }}>
          Transcribed by
        </span>
        <span style={{ display:'inline-flex', alignItems:'center', gap:'7px',
          padding:'5px 12px', borderRadius:'8px',
          fontSize:'11px', fontWeight:800, letterSpacing:'0.04em',
          background:`${engine.color}15`, color:engine.color,
          border:`1px solid ${engine.color}40`,
          boxShadow:`0 0 12px ${engine.color}25` }}>
          <span style={{ fontSize:'12px' }}>{engine.icon}</span>
          {engine.label}
        </span>
        {source && (
          <span style={{ fontSize:'10px', color:'#64748B',
            padding:'4px 10px', borderRadius:'6px',
            background:'rgba(255,255,255,0.03)',
            border:'1px solid #1F2937' }}>
            source · {String(source).replace(/_/g, ' ')}
          </span>
        )}
      </div>

      <div style={{ display:'grid',
        gridTemplateColumns: tx.urdu && tx.english ? '1fr 1fr' : '1fr',
        gap:'10px' }}>
        {tx.urdu && (
          <div>
            <div style={{ fontSize:'9px', color:'#94A3B8', fontWeight:800,
              letterSpacing:'0.10em', textTransform:'uppercase',
              marginBottom:'6px' }}>
              Urdu / اردو
            </div>
            <div style={{ fontSize:'13px', color:'#F1F5F9', lineHeight:1.85,
              padding:'14px 16px', borderRadius:'10px',
              background:'rgba(0,0,0,0.25)', borderLeft:'3px solid #3B82F6',
              direction:'rtl', textAlign:'right',
              maxHeight:'260px', overflow:'auto', fontFamily:'system-ui' }}>
              {tx.urdu}
            </div>
          </div>
        )}
        {tx.english && (
          <div>
            <div style={{ fontSize:'9px', color:'#94A3B8', fontWeight:800,
              letterSpacing:'0.10em', textTransform:'uppercase',
              marginBottom:'6px' }}>
              English
            </div>
            <div style={{ fontSize:'12px', color:'#CBD5E1', lineHeight:1.7,
              padding:'14px 16px', borderRadius:'10px',
              background:'rgba(0,0,0,0.18)', borderLeft:'3px solid #6366F1',
              fontStyle:'italic', maxHeight:'260px', overflow:'auto' }}>
              {tx.english}
            </div>
          </div>
        )}
      </div>
    </PanelCard>
  )
}

// Map raw method strings → friendly label + icon + colour.
// Python emits values like "gemini_2.5_flash", "gemini_2.5_flash_lite",
// "whisper", "faster-whisper", "google_speech", etc.
function describeEngine(method) {
  const m = String(method || '').toLowerCase()
  if (m.includes('gemini')) {
    const ver = m.includes('flash_lite') ? '2.5 Flash-Lite'
              : m.includes('flash')      ? '2.5 Flash'
              : m.includes('pro')        ? '2.5 Pro'
              : '2.5'
    return { label:`Gemini ${ver}`, icon:'✦', color:'#A78BFA' }
  }
  if (m.includes('whisper')) {
    const variant = m.includes('faster') ? ' (faster)'
                  : m.includes('large')  ? ' (large)'
                  : m.includes('medium') ? ' (medium)'
                  : ''
    return { label:`Whisper${variant}`, icon:'◆', color:'#60A5FA' }
  }
  if (m.includes('google')) return { label:'Google Speech', icon:'◉', color:'#34D399' }
  if (m) return { label: method, icon:'◇', color:'#94A3B8' }
  return { label:'Unknown engine', icon:'?', color:'#64748B' }
}

// ── Violations grouped by category ────────────────────────────────
function ViolationsPanel({ violations }) {
  if (!violations.length) {
    return (
      <PanelCard title="Violations" subtitle="0 detected">
        <div style={{ padding:'20px', textAlign:'center',
          color:'#10B981', fontSize:'13px' }}>
          ✓ Officer conduct was within standards — no violations recorded.
        </div>
      </PanelCard>
    )
  }

  // Group by violation type for category-level summary.
  const byType = {}
  violations.forEach(v => {
    const k = v.type || 'OTHER'
    if (!byType[k]) byType[k] = []
    byType[k].push(v)
  })
  const types = Object.keys(byType).sort((a, b) => byType[b].length - byType[a].length)

  return (
    <PanelCard title="Violations" subtitle={`${violations.length} detected`}>
      {/* Category chip row */}
      <div style={{ display:'flex', gap:'8px', flexWrap:'wrap',
        marginBottom:'14px' }}>
        {types.map(t => {
          const meta = violationMeta(t)
          return (
            <span key={t} style={{ display:'inline-flex', alignItems:'center',
              gap:'7px', padding:'5px 12px', borderRadius:'8px',
              fontSize:'10px', fontWeight:800, letterSpacing:'0.04em',
              background:`${meta.color}15`, color: meta.color,
              border:`1px solid ${meta.color}40` }}>
              <span style={{ fontSize:'12px' }}>{meta.icon}</span>
              {t}
              <span style={{ background:`${meta.color}25`,
                padding:'1px 6px', borderRadius:'5px',
                fontWeight:900 }}>{byType[t].length}</span>
            </span>
          )
        })}
      </div>

      {/* Per-violation cards */}
      {violations.map((v, i) => {
        const meta = violationMeta(v.type)
        const vsev = SEV[v.severity] || SEV.WARNING
        const keywords = v.keywords_found || asKeywordsArray(v.keywordsFound)
        const detail = v.detail
        const impact = num(v.impact_percent)
        return (
          <div key={v.id || i} style={{ padding:'14px 16px', marginBottom:'10px',
            borderRadius:'12px', background:'rgba(0,0,0,0.22)',
            border:`1px solid ${vsev.border}`,
            borderLeft:`4px solid ${meta.color}` }}>
            <div style={{ display:'flex', alignItems:'center', gap:'10px',
              marginBottom:'6px', flexWrap:'wrap' }}>
              <span style={{ fontSize:'15px', color: meta.color,
                fontWeight:900, width:22, textAlign:'center' }}>{meta.icon}</span>
              <span style={{ fontSize:'12px', color: meta.color,
                fontWeight:800, letterSpacing:'0.04em' }}>{v.type}</span>
              <span style={{ fontSize:'9px', color:'#64748B',
                background:'rgba(255,255,255,0.04)', padding:'2px 7px',
                borderRadius:'5px', textTransform:'uppercase',
                letterSpacing:'0.06em', fontWeight:700 }}>
                {v.source || 'gemini'}
              </span>
              <span style={{ fontSize:'9px', fontWeight:800,
                padding:'2px 8px', borderRadius:'5px',
                letterSpacing:'0.05em', textTransform:'uppercase',
                color: vsev.color, background: vsev.bg,
                border:`1px solid ${vsev.border}` }}>
                {v.severity_label || v.severity}
              </span>
              <span style={{ marginLeft:'auto', fontSize:'12px',
                color:vsev.color, fontWeight:800,
                fontVariantNumeric:'tabular-nums' }}>
                +{v.score || 0}
                {impact > 0 && (
                  <span style={{ fontSize:'10px', color:'#64748B',
                    fontWeight:600, marginLeft:'5px' }}>
                    ({impact.toFixed(0)}%)
                  </span>
                )}
              </span>
            </div>
            {(v.label || meta.label) && (
              <div style={{ fontSize:'13px', color:'#F1F5F9',
                fontWeight:700, marginBottom:'4px' }}>
                {v.label || meta.label}
              </div>
            )}
            {v.description && (
              <div style={{ fontSize:'12px', color:'#94A3B8',
                lineHeight:1.55, marginBottom: detail ? '4px' : 0 }}>
                {v.description}
              </div>
            )}
            {detail && detail !== v.description && (
              <div style={{ fontSize:'11px', color:'#94A3B8',
                lineHeight:1.55, fontStyle:'italic' }}>{detail}</div>
            )}
            {keywords.length > 0 && (
              <div style={{ marginTop:'8px', display:'flex',
                flexWrap:'wrap', gap:'5px' }}>
                <span style={{ fontSize:'9px', color:'#64748B',
                  fontWeight:800, letterSpacing:'0.10em',
                  textTransform:'uppercase', marginRight:'4px',
                  alignSelf:'center' }}>
                  Keywords detected:
                </span>
                {keywords.map((kw, ki) => (
                  <span key={ki} style={{ display:'inline-block',
                    fontSize:'12px', color:'#FBBF24',
                    padding:'4px 10px', borderRadius:'7px',
                    background:'rgba(251,191,36,0.08)',
                    border:'1px solid rgba(251,191,36,0.30)',
                    fontFamily:'system-ui',
                    direction: /[؀-ۿ]/.test(kw) ? 'rtl' : 'ltr',
                    fontWeight:600 }}>
                    {kw}
                  </span>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </PanelCard>
  )
}

// ──────────────────────────────────────────────────────────────────
// Tiny presentational primitives
// ──────────────────────────────────────────────────────────────────

function PanelCard({ title, subtitle, children }) {
  return (
    <div style={{ padding:'18px 20px', borderRadius:'14px', marginBottom:'14px',
      background:'rgba(255,255,255,0.025)', border:'1px solid #1F2937' }}>
      <div style={{ marginBottom:'14px' }}>
        <div style={{ fontSize:'10px', color:'#64748B', fontWeight:800,
          letterSpacing:'0.10em', textTransform:'uppercase' }}>
          {title}
        </div>
        {subtitle && (
          <div style={{ fontSize:'11px', color:'#475569', marginTop:'3px',
            fontWeight:500 }}>{subtitle}</div>
        )}
      </div>
      {children}
    </div>
  )
}

function Grid({ cols, children }) {
  return (
    <div style={{ display:'grid', gridTemplateColumns:cols, gap:'14px' }}>
      {children}
    </div>
  )
}

function Stat({ label, val, c }) {
  return (
    <span style={{ display:'inline-flex', flexDirection:'column',
      gap:'2px', padding:'5px 12px', borderRadius:'8px',
      background:'rgba(0,0,0,0.25)', border:'1px solid #1F2937' }}>
      <span style={{ fontSize:'9px', color:'#64748B', fontWeight:700,
        letterSpacing:'0.06em', textTransform:'uppercase' }}>{label}</span>
      <span style={{ fontSize:'14px', fontWeight:800, color:c,
        lineHeight:1, fontVariantNumeric:'tabular-nums' }}>{val}</span>
    </span>
  )
}

function Metric({ label, val, sub, color }) {
  return (
    <div style={{ padding:'12px 14px', borderRadius:'10px',
      background:'rgba(0,0,0,0.25)', border:'1px solid #1F2937' }}>
      <div style={{ fontSize:'9px', color:'#64748B', fontWeight:700,
        letterSpacing:'0.08em', textTransform:'uppercase',
        marginBottom:'6px' }}>{label}</div>
      <div style={{ fontSize:'18px', fontWeight:800, color, lineHeight:1,
        fontVariantNumeric:'tabular-nums' }}>{val}</div>
      {sub && (
        <div style={{ fontSize:'10px', color:'#94A3B8', marginTop:'4px' }}>
          {sub}
        </div>
      )}
    </div>
  )
}

function BarMeter({ label, value, max, color, suffix = '' }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100))
  return (
    <div style={{ marginBottom:'10px' }}>
      <div style={{ display:'flex', justifyContent:'space-between',
        marginBottom:'5px', fontSize:'11px' }}>
        <span style={{ color:'#94A3B8', fontWeight:600 }}>{label}</span>
        <span style={{ color, fontWeight:800,
          fontVariantNumeric:'tabular-nums' }}>
          {(typeof value === 'number' ? value : 0).toFixed(1)}{suffix}
        </span>
      </div>
      <div style={{ height:'6px', background:'rgba(255,255,255,0.06)',
        borderRadius:'4px', overflow:'hidden' }}>
        <div style={{ width:`${pct}%`, height:'100%', background:color,
          boxShadow:`0 0 10px ${color}80`, borderRadius:'4px',
          transition:'width 0.6s ease' }}/>
      </div>
    </div>
  )
}

function Donut({ slices, size = 140, centerLabel, centerColor }) {
  const r = size / 2 - 12
  const circ = 2 * Math.PI * r
  const total = slices.reduce((a, s) => a + s.val, 0) || 1
  let offset = 0

  return (
    <div style={{ position:'relative', width:size, height:size, flexShrink:0 }}>
      <svg width={size} height={size} style={{ transform:'rotate(-90deg)' }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none"
          stroke="rgba(255,255,255,0.05)" strokeWidth="14"/>
        {slices.map((s, i) => {
          const len = (s.val / total) * circ
          const dash = `${len} ${circ - len}`
          const o = -offset
          offset += len
          return (
            <circle key={i} cx={size/2} cy={size/2} r={r} fill="none"
              stroke={s.color} strokeWidth="14"
              strokeDasharray={dash} strokeDashoffset={o}
              strokeLinecap="butt"/>
          )
        })}
      </svg>
      <div style={{ position:'absolute', inset:0, display:'flex',
        flexDirection:'column', alignItems:'center', justifyContent:'center' }}>
        <div style={{ fontSize:'11px', fontWeight:800,
          color: centerColor || '#94A3B8', letterSpacing:'0.06em' }}>
          {centerLabel}
        </div>
        <div style={{ fontSize:'9px', color:'#64748B',
          letterSpacing:'0.08em', marginTop:'2px' }}>DOMINANT</div>
      </div>
    </div>
  )
}

function ScoreRing({ score, severity, size = 96 }) {
  const sev = SEV[severity] || SEV.NORMAL
  const r = size / 2 - 7
  const circ = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(100, score)) / 100
  return (
    <div style={{ position:'relative', width:size, height:size, flexShrink:0 }}>
      <svg width={size} height={size} style={{ transform:'rotate(-90deg)' }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none"
          stroke="rgba(255,255,255,0.06)" strokeWidth="7"/>
        <circle cx={size/2} cy={size/2} r={r} fill="none"
          stroke={sev.color} strokeWidth="7" strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - pct)}
          style={{ transition:'stroke-dashoffset 0.6s ease',
            filter:`drop-shadow(0 0 6px ${sev.color}80)` }}/>
      </svg>
      <div style={{ position:'absolute', inset:0, display:'flex',
        flexDirection:'column', alignItems:'center', justifyContent:'center' }}>
        <div style={{ fontSize: size > 100 ? '28px' : '22px',
          fontWeight:900, color:sev.color, lineHeight:1,
          letterSpacing:'-0.02em' }}>{score}</div>
        <div style={{ fontSize:'9px', color:'#64748B',
          letterSpacing:'0.10em', marginTop:'3px', fontWeight:800 }}>/100</div>
      </div>
    </div>
  )
}

function SeverityChip({ severity }) {
  const sev = SEV[severity] || SEV.NORMAL
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:'7px',
      padding:'5px 12px', borderRadius:'8px',
      fontSize:'11px', fontWeight:800, letterSpacing:'0.08em',
      background:sev.bg, color:sev.color, border:`1px solid ${sev.border}`,
      textTransform:'uppercase' }}>
      <span style={{ width:6, height:6, borderRadius:'50%',
        background:sev.color, boxShadow:`0 0 8px ${sev.color}` }}/>
      {severity || 'PENDING'}
    </span>
  )
}

function ToneChip({ tone, overallSeverity }) {
  // Mute the chip when the tone *sounds* alarming (ANGRY / HARSH / BRIBE)
  // but the overall severity is NORMAL — i.e. raised voice without abusive
  // language. Keeps the visual coherent with the actual severity band.
  const muted =
    /ANGRY|HARSH|BRIBE/.test(tone || '') && overallSeverity === 'NORMAL'
  const c = muted ? '#94A3B8' : (TONE_COLOR[tone] || '#64748B')
  return (
    <span title={muted
        ? `Voice classified ${tone} but no abusive language detected → severity stays NORMAL`
        : undefined}
      style={{ display:'inline-flex', alignItems:'center',
      padding:'4px 10px', borderRadius:'7px',
      fontSize:'10px', fontWeight:800, letterSpacing:'0.06em',
      background:`${c}15`, color:c, border:`1px solid ${c}40`,
      textTransform:'uppercase',
      opacity: muted ? 0.85 : 1 }}>
      ◉ Tone: {tone || 'UNKNOWN'}
      {muted && (
        <span style={{ marginLeft:'6px', fontSize:'8px', opacity:0.7,
          fontWeight:700 }}>· acoustic only</span>
      )}
    </span>
  )
}

function CloseBtn({ onClick }) {
  return (
    <button onClick={onClick}
      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(51,65,85,0.55)'; e.currentTarget.style.color = '#F1F5F9' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'rgba(31,41,55,0.65)'; e.currentTarget.style.color = '#94A3B8' }}
      style={{ position:'absolute', top:'18px', right:'18px',
        background:'rgba(31,41,55,0.65)', border:'1px solid #334155',
        color:'#94A3B8', borderRadius:'10px', padding:'7px 13px',
        fontSize:'11px', fontWeight:700, cursor:'pointer',
        letterSpacing:'0.04em', transition:'all .15s',
        backdropFilter:'blur(8px)', zIndex:5 }}>
      ✕  Close · Esc
    </button>
  )
}

function ModalLoading() {
  return (
    <div style={{ padding:'80px 20px', textAlign:'center' }}>
      <div style={{ fontSize:'34px', marginBottom:'14px',
        animation:'pulse 1.4s ease-in-out infinite' }}>◧</div>
      <div style={{ fontSize:'14px', color:'#94A3B8',
        fontWeight:700, letterSpacing:'-0.01em' }}>
        Loading full assessment from MSSQL…
      </div>
    </div>
  )
}

function ModalError({ message }) {
  return (
    <div style={{ padding:'56px 24px', textAlign:'center' }}>
      <div style={{ fontSize:'40px', marginBottom:'14px', opacity:0.6 }}>⚠</div>
      <div style={{ fontSize:'14px', fontWeight:700, color:'#F87171',
        marginBottom:'6px' }}>Could not load this recording</div>
      <div style={{ fontSize:'12px', color:'#94A3B8', maxWidth:'420px',
        margin:'0 auto', lineHeight:1.6 }}>{message}</div>
    </div>
  )
}

function Empty({ children }) {
  return (
    <div style={{ padding:'24px', textAlign:'center',
      color:'#64748B', fontSize:'12px', fontStyle:'italic' }}>
      {children}
    </div>
  )
}

// Coerce nullable number / string to a finite number.
function num(v) {
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : 0
}
function pctNum(v) {
  // The .NET DTO already stores tonePercent* in 0–100. Coerce + clamp.
  const n = num(v)
  return Math.max(0, Math.min(100, n))
}
