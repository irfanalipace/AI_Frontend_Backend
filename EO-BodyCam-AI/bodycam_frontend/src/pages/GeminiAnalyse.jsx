import React, { useEffect, useRef, useState } from 'react'
import { Spinner } from '../components/UI'
import { ResultPanel, MediaPlayer } from './Upload'
import ApiService from '../services/api'

/**
 * Gemini Analysis tab.
 *
 * Wired to the .NET backend (POST :8080/api/analyse). The .NET service
 * extracts audio with ffmpeg, forwards it to the Python pipeline at
 * :5050/api/analyze/upload, persists the result to MSSQL, and returns
 * the same rich snake_case JSON the Upload page renders. We therefore
 * reuse Upload's <ResultPanel/> and <MediaPlayer/> as-is — every panel
 * (Greeting, Diarization, Tone Classifier, Speech Detected, Officer
 * Behavior Assessment, Visual Analysis, Violations, Acoustics, Emotions)
 * shows up identically here.
 */

const CARD = {
  background: '#111827', border: '1px solid #1F2937',
  borderRadius: '16px', padding: '22px', marginBottom: '14px',
}
const LABEL = {
  fontSize: '10px', color: '#64748B', textTransform: 'uppercase',
  letterSpacing: '0.08em', fontWeight: 700, marginBottom: '10px', display: 'block',
}

const OFFICERS = [
  { id: 'EO_001', name: 'Irfan Ali — PK-LHR-001' },
  { id: 'EO_002', name: 'Umar Farooq — PK-LHR-002' },
  { id: 'EO_003', name: 'Fatima Malik — PK-KHI-001' },
]

const PROGRESS_STEPS = [
  'Uploading to .NET backend...',
  'Extracting audio with ffmpeg...',
  'Forwarding to Python pipeline...',
  'Detecting EO voice...',
  'Transcribing Urdu speech...',
  'Calling Gemini for assessment...',
  'Saving to database...',
]

const ACCEPT = '.wav,.mp3,.mp4,.webm,.ogg,.m4a,.flac,.mov,.avi,.mkv,.aac,.3gp,audio/*,video/*'

export default function GeminiAnalyse() {
  const [file,    setFile]    = useState(null)
  const [officer, setOfficer] = useState('EO_001')
  const [station, setStation] = useState('')
  const [result,  setResult]  = useState(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)
  const [drag,    setDrag]    = useState(false)
  const [progress, setProgress] = useState('')
  const [mediaUrl, setMediaUrl] = useState(null)
  const [health,  setHealth]  = useState(null)
  const inputRef = useRef()

  // Probe .NET health once on mount.
  useEffect(() => {
    let cancelled = false
    ApiService.geminiHealth()
      .then(r => { if (!cancelled) setHealth({ ok: true, ...r.data }) })
      .catch(() => { if (!cancelled) setHealth({ ok: false }) })
    return () => { cancelled = true }
  }, [])

  const handleFile = f => {
    if (!f) return
    if (mediaUrl) URL.revokeObjectURL(mediaUrl)
    setFile(f); setResult(null); setError(null)
    setMediaUrl(URL.createObjectURL(f))
  }

  const onDrop = e => {
    e.preventDefault(); setDrag(false)
    handleFile(e.dataTransfer.files[0])
  }

  const analyse = async () => {
    if (!file) return
    setLoading(true); setError(null); setResult(null)
    let si = 0
    const timer = setInterval(
      () => setProgress(PROGRESS_STEPS[si++ % PROGRESS_STEPS.length]),
      2200,
    )
    try {
      const r = await ApiService.analyseGemini(file, officer, station.trim())
      setResult(r.data)
    } catch (e) {
      const msg = e.response?.data?.error
        || e.response?.statusText
        || e.message
        || 'Could not reach the .NET backend on :8080. Run `dotnet run --project PERA360.Api` first.'
      setError(msg)
    } finally {
      clearInterval(timer); setLoading(false); setProgress('')
    }
  }

  const isVideo = file?.type?.startsWith('video')

  return (
    <div style={{ padding: '30px', maxWidth: '1200px' }}>

      {/* Header */}
      <div style={{ marginBottom: '20px', display: 'flex',
        justifyContent: 'space-between', alignItems: 'flex-start',
        gap: '20px', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 800, color: '#F1F5F9',
            margin: '0 0 6px', letterSpacing: '-0.02em' }}>
            Gemini Analysis
          </h1>
          <p style={{ fontSize: '13px', color: '#64748B', lineHeight: 1.6, margin: 0 }}>
            .NET orchestrator → Python ML pipeline → Gemini narrative + DB persistence.
            Same rich result panel as the Upload tab.
          </p>
        </div>
        <BackendStatus health={health}/>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '420px 1fr',
        gap: '24px', alignItems: 'start' }}>

        {/* ── LEFT: form ─────────────────────────────────────────── */}
        <div>
          {/* Drop zone */}
          <div style={CARD}>
            <span style={LABEL}>Audio / Video File</span>
            <div
              onDragOver={e => { e.preventDefault(); setDrag(true) }}
              onDragLeave={() => setDrag(false)}
              onDrop={onDrop}
              onClick={() => inputRef.current.click()}
              style={{
                border: `2px dashed ${drag ? '#3B82F6' : '#2D3348'}`,
                borderRadius: '14px', padding: '36px 20px', textAlign: 'center',
                cursor: 'pointer',
                background: drag ? 'rgba(59,130,246,0.08)' : '#0B0F1A',
                transition: 'all .25s',
              }}>
              <input ref={inputRef} type="file" accept={ACCEPT}
                style={{ display: 'none' }}
                onChange={e => handleFile(e.target.files[0])}/>
              {file ? (
                <div>
                  <div style={{ fontSize: '32px', marginBottom: '10px', color: '#10B981' }}>✓</div>
                  <div style={{ fontSize: '14px', fontWeight: 700, color: '#F1F5F9',
                    marginBottom: '6px', wordBreak: 'break-all' }}>{file.name}</div>
                  <div style={{ fontSize: '12px', color: '#64748B' }}>
                    {(file.size / 1024 / 1024).toFixed(2)} MB ·
                    {' '}{isVideo ? '🎬 Video' : '🎙 Audio'} · Click to change
                  </div>
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: '32px', color: '#3B82F6', marginBottom: '10px' }}>↑</div>
                  <div style={{ fontSize: '14px', fontWeight: 700, color: '#94A3B8',
                    marginBottom: '6px' }}>Drop Audio or Video here</div>
                  <div style={{ fontSize: '11px', color: '#10B981', fontWeight: 600, marginBottom: '4px' }}>
                    🎙 Audio: WAV · MP3 · OGG · M4A · FLAC · AAC
                  </div>
                  <div style={{ fontSize: '11px', color: '#3B82F6', fontWeight: 600 }}>
                    🎬 Video: MP4 · WebM · MOV · AVI · MKV · 3GP
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Media Player — shows after upload (same as Upload tab) */}
          {file && mediaUrl && (
            <MediaPlayer file={file} url={mediaUrl} diarization={result?.diarization}/>
          )}

          {/* Officer + station */}
          <div style={CARD}>
            <label style={LABEL}>Select Officer</label>
            <select value={officer} onChange={e => setOfficer(e.target.value)}>
              {OFFICERS.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>

            <label style={{ ...LABEL, marginTop: '14px' }}>Station ID (optional)</label>
            <input type="text" value={station} onChange={e => setStation(e.target.value)}
              placeholder="e.g. PK-LHR-Anarkali"
              style={{
                width: '100%', padding: '10px 12px',
                background: '#0B0F1A', border: '1px solid #1F2937',
                borderRadius: '8px', fontSize: '13px', color: '#F1F5F9',
                outline: 'none', fontFamily: 'inherit',
              }}/>
          </div>

          {/* What this tab does */}
          <div style={{ ...CARD, background: '#0B0F1A', border: '1px solid #1F2937' }}>
            <span style={LABEL}>Pipeline (.NET → Python → DB)</span>
            {[
              { icon: '🌐', color: '#3B82F6', title: '.NET orchestrator',
                desc: 'Receives upload at :8080/api/analyse, audits + persists.' },
              { icon: '🎙', color: '#10B981', title: 'ffmpeg audio strip',
                desc: 'Video is never sent — only a 16 kHz mono MP3 is forwarded.' },
              { icon: '🐍', color: '#F59E0B', title: 'Python ML pipeline',
                desc: 'Voiceprint, diarization, SVM tone, Whisper, emotions.' },
              { icon: '✦', color: '#8B5CF6', title: 'Gemini assessment',
                desc: 'Narrative summary, behavior categories, recommended action.' },
              { icon: '💾', color: '#06B6D4', title: 'MSSQL persistence',
                desc: 'Recording + AnalysisResult + Violations saved per upload.' },
            ].map(s => (
              <div key={s.title} style={{ display: 'flex', gap: '12px',
                alignItems: 'flex-start', marginBottom: '12px' }}>
                <div style={{ fontSize: '16px', flexShrink: 0, marginTop: '1px' }}>{s.icon}</div>
                <div>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: s.color, marginBottom: '2px' }}>
                    {s.title}
                  </div>
                  <div style={{ fontSize: '11px', color: '#64748B' }}>{s.desc}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Buttons */}
          <div style={{ display: 'flex', gap: '10px' }}>
            <button onClick={analyse} disabled={!file || loading}
              style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                gap: '8px', padding: '13px',
                background: (!file || loading)
                  ? '#1F2937'
                  : 'linear-gradient(135deg, #3B82F6, #6366F1)',
                color: (!file || loading) ? '#475569' : '#fff',
                border: 'none', borderRadius: '12px',
                fontSize: '14px', fontWeight: 700,
                cursor: (!file || loading) ? 'not-allowed' : 'pointer',
                boxShadow: (!file || loading) ? 'none' : '0 4px 16px rgba(59,130,246,0.3)',
                transition: 'all .2s',
              }}>
              {loading
                ? <><Spinner size={16} color="#fff"/>{progress || 'Analyzing...'}</>
                : '◎  Analyze with Gemini'}
            </button>
            <button onClick={() => { setFile(null); setResult(null); setError(null) }}
              style={{
                padding: '13px 20px', background: '#1F2937',
                border: '1px solid #2D3348', borderRadius: '12px',
                fontSize: '13px', cursor: 'pointer', color: '#94A3B8', fontWeight: 600,
              }}>
              Clear
            </button>
          </div>

          {error && (
            <div style={{ marginTop: '12px',
              background: 'rgba(239,68,68,0.1)',
              border: '1px solid rgba(239,68,68,0.25)',
              borderRadius: '10px', padding: '14px 16px',
              fontSize: '12px', color: '#EF4444', lineHeight: 1.5 }}>
              <div style={{ fontWeight: 700, marginBottom: '4px' }}>Analysis failed</div>
              {error}
            </div>
          )}
        </div>

        {/* ── RIGHT: result ─────────────────────────────────────── */}
        <div>
          {loading && (
            <div style={{ ...CARD, textAlign: 'center', padding: '70px 40px' }}>
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '22px' }}>
                <Spinner size={40} color="#3B82F6"/>
              </div>
              <div style={{ fontSize: '16px', fontWeight: 700, color: '#F1F5F9', marginBottom: '10px' }}>
                Gemini pipeline analysing {isVideo ? 'video' : 'audio'}
              </div>
              <div style={{ fontSize: '13px', color: '#3B82F6', minHeight: '20px', fontWeight: 600 }}>
                {progress || 'Processing...'}
              </div>
              <div style={{ fontSize: '11px', color: '#475569', marginTop: '12px' }}>
                Audio extraction · ML pipeline · Gemini assessment · DB save
              </div>
            </div>
          )}

          {!loading && !result && !error && (
            <div style={{ ...CARD, textAlign: 'center', padding: '70px 40px' }}>
              <div style={{ fontSize: '40px', color: '#2D3348', marginBottom: '16px' }}>◎</div>
              <div style={{ fontSize: '15px', fontWeight: 700, color: '#475569', marginBottom: '10px' }}>
                Upload a recording to begin
              </div>
              <div style={{ fontSize: '12px', color: '#374151', lineHeight: 1.8 }}>
                .NET → ffmpeg → Python ML → Gemini → MSSQL.<br/>
                Result panel matches the Upload tab.
              </div>
            </div>
          )}

          {/* Reuse Upload's exact ResultPanel — every component (Greeting,
              Diarization, Tone, Transcript, Behavior Assessment, Visual,
              Violations, Acoustics, Emotions) renders identically. */}
          {result && !loading && <ResultPanel result={result}/>}
        </div>
      </div>
    </div>
  )
}

// ── Backend status pill (top right) ──────────────────────────────
function BackendStatus({ health }) {
  const ok = health?.ok
  const color = ok ? '#10B981' : health === null ? '#64748B' : '#EF4444'
  const label = ok ? '.NET backend online'
    : health === null ? 'checking...'
    : '.NET backend offline'
  return (
    <div style={{ background: '#111827', border: `1px solid ${color}40`,
      borderRadius: '10px', padding: '10px 14px', display: 'flex',
      alignItems: 'center', gap: '10px', flexShrink: 0 }}>
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: color,
        boxShadow: `0 0 8px ${color}80` }}/>
      <div>
        <div style={{ fontSize: '11px', fontWeight: 700, color, letterSpacing: '0.04em' }}>
          {label}
        </div>
        <div style={{ fontSize: '10px', color: '#64748B' }}>
          {ok ? 'POST :8080/api/analyse' : 'Run dotnet run --project PERA360.Api'}
        </div>
      </div>
    </div>
  )
}
