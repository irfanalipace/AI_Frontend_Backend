import React, { useState, useEffect, useRef } from 'react'
import { Spinner } from '../components/UI'
import ApiService from '../services/api'

const CARD  = { background:'#ffffff', border:'0.5px solid #D3D1C7', borderRadius:'12px', padding:'20px' }
const LABEL = { fontSize:'10px', color:'#888780', textTransform:'uppercase', letterSpacing:'0.07em', fontWeight:700, marginBottom:'8px', display:'block' }

export default function Officers() {
  const [officers,  setOfficers]  = useState([])
  const [loading,   setLoading]   = useState(true)
  const [form,      setForm]      = useState({ id:'', name:'', area:'' })
  const [audioFile, setAudio]     = useState(null)
  const [enrolling, setEnrolling] = useState(false)
  const [msg,       setMsg]       = useState(null)
  const fileRef = useRef()

  const load = () => {
    setLoading(true)
    ApiService.getOfficers()
      .then(r => setOfficers(r.data.officers))
      .catch(() => setMsg({ type:'error', text:'Cannot reach server. Is backend running?' }))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const enroll = async () => {
    setMsg(null)

    // Validate
    if (!form.id.trim()) {
      setMsg({ type:'error', text:'Officer ID is required — e.g. EO_004' })
      return
    }
    if (!form.name.trim()) {
      setMsg({ type:'error', text:'Full name is required — e.g. Muhammad Bilal' })
      return
    }
    if (!audioFile) {
      setMsg({ type:'error', text:'Please select an audio file (WAV/MP3)' })
      return
    }

    setEnrolling(true)
    setMsg({ type:'info', text:'Enrolling... building voice fingerprint. Please wait.' })

    try {
      const r = await ApiService.enrollOfficer(
        form.id.trim(),
        form.name.trim(),
        form.area.trim(),
        audioFile
      )
      setMsg({
        type: 'success',
        text: `✓ ${r.data.name} enrolled! Voice pitch: ${r.data.pitch_hz}Hz · ${r.data.windows || ''} windows`
      })
      setForm({ id:'', name:'', area:'' })
      setAudio(null)
      if (fileRef.current) fileRef.current.value = ''
      load()
    } catch(e) {
      console.error('Enroll error:', e)
      let errText = 'Enrollment failed'
      if (e.code === 'ECONNABORTED') {
        errText = 'Request timed out — audio file may be too large, try a shorter clip'
      } else if (e.response?.data?.error) {
        errText = e.response.data.error
      } else if (e.message) {
        errText = e.message
      }
      setMsg({ type:'error', text: errText })
    } finally {
      setEnrolling(false)
    }
  }

  const initials = name =>
    name.split(' ').filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase()

  const msgStyle = {
    info:    { bg:'#E6F1FB', border:'#B5D4F4', color:'#0C447C' },
    success: { bg:'#E1F5EE', border:'#9FE1CB', color:'#0F6E56' },
    error:   { bg:'#FCEBEB', border:'#F09595', color:'#A32D2D' },
  }

  return (
    <div style={{ padding:'28px', maxWidth:'960px' }}>
      <div style={{ marginBottom:'24px' }}>
        <h1 style={{ fontSize:'22px', fontWeight:700, color:'#2C2C2A', marginBottom:'4px' }}>
          Officers
        </h1>
        <p style={{ fontSize:'13px', color:'#888780' }}>
          Manage officer voice enrollments and profiles
        </p>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'20px' }}>

        {/* ── Officer list ── */}
        <div style={CARD}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'16px' }}>
            <span style={{ ...LABEL, marginBottom:0 }}>Enrolled Officers</span>
            <button onClick={load}
              style={{ fontSize:'11px', color:'#185FA5', background:'transparent', border:'none', cursor:'pointer' }}>
              ↻ Refresh
            </button>
          </div>

          {loading ? (
            <div style={{ textAlign:'center', padding:'30px' }}><Spinner size={24}/></div>
          ) : officers.length === 0 ? (
            <div style={{ textAlign:'center', padding:'30px', color:'#B4B2A9', fontSize:'13px' }}>
              No officers enrolled yet
            </div>
          ) : (
            officers.map(o => (
              <div key={o.id} style={{ display:'flex', alignItems:'center', gap:'12px',
                padding:'13px 14px', background:'#F8F7F4', border:'0.5px solid #E8E6DF',
                borderRadius:'10px', marginBottom:'8px' }}>

                <div style={{ width:42, height:42, borderRadius:'10px', flexShrink:0,
                  background: o.enrolled ? '#E1F5EE' : '#F8F7F4',
                  display:'flex', alignItems:'center', justifyContent:'center',
                  fontSize:'14px', fontWeight:800,
                  color: o.enrolled ? '#0F6E56' : '#888780',
                  border:`0.5px solid ${o.enrolled ? '#9FE1CB' : '#D3D1C7'}` }}>
                  {initials(o.name)}
                </div>

                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:'14px', fontWeight:700, color:'#2C2C2A', marginBottom:'2px' }}>
                    {o.name}
                  </div>
                  <div style={{ fontSize:'11px', color:'#888780' }}>
                    {o.id} · {o.badge} · {o.area || 'No area'}
                  </div>
                </div>

                <span style={{ fontSize:'10px', fontWeight:700, padding:'4px 10px',
                  borderRadius:'8px', whiteSpace:'nowrap', flexShrink:0,
                  background: o.enrolled ? '#E1F5EE' : '#F8F7F4',
                  color: o.enrolled ? '#0F6E56' : '#888780',
                  border:`0.5px solid ${o.enrolled ? '#9FE1CB' : '#D3D1C7'}` }}>
                  {o.enrolled ? '✓ Enrolled' : 'Not enrolled'}
                </span>
              </div>
            ))
          )}
        </div>

        {/* ── Enroll form ── */}
        <div style={CARD}>
          <span style={LABEL}>Enroll New Officer</span>

          <div style={{ display:'flex', flexDirection:'column', gap:'14px' }}>

            {/* Officer ID */}
            <div>
              <label style={LABEL}>
                Officer ID
                <span style={{ fontWeight:400, textTransform:'none', letterSpacing:0,
                  marginLeft:'4px', color:'#B4B2A9' }}>e.g. EO_004</span>
              </label>
              <input
                placeholder="EO_004"
                value={form.id}
                onChange={e => { setForm(p => ({ ...p, id: e.target.value })); setMsg(null) }}
              />
            </div>

            {/* Full Name */}
            <div>
              <label style={LABEL}>
                Full Name
                <span style={{ fontWeight:400, textTransform:'none', letterSpacing:0,
                  marginLeft:'4px', color:'#B4B2A9' }}>e.g. Muhammad Bilal</span>
              </label>
              <input
                placeholder="Muhammad Bilal"
                value={form.name}
                onChange={e => { setForm(p => ({ ...p, name: e.target.value })); setMsg(null) }}
              />
            </div>

            {/* Area */}
            <div>
              <label style={LABEL}>
                Area / Zone
                <span style={{ fontWeight:400, textTransform:'none', letterSpacing:0,
                  marginLeft:'4px', color:'#B4B2A9' }}>optional</span>
              </label>
              <input
                placeholder="Lahore - Gulberg"
                value={form.area}
                onChange={e => setForm(p => ({ ...p, area: e.target.value }))}
              />
            </div>

            {/* Audio file */}
            <div>
              <label style={LABEL}>
                Enrollment Audio
                <span style={{ fontWeight:400, textTransform:'none', letterSpacing:0,
                  marginLeft:'4px', color:'#B4B2A9' }}>10–30 sec of officer speaking</span>
              </label>
              <div
                onClick={() => !enrolling && fileRef.current.click()}
                style={{ border:`0.5px dashed ${audioFile ? '#1D9E75' : '#D3D1C7'}`,
                  borderRadius:'9px', padding:'18px', textAlign:'center',
                  cursor: enrolling ? 'not-allowed' : 'pointer',
                  background: audioFile ? '#E1F5EE' : '#F8F7F4', transition:'all .2s' }}>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".wav,.mp3,.m4a,.ogg,.webm"
                  style={{ display:'none' }}
                  onChange={e => {
                    if (e.target.files[0]) {
                      setAudio(e.target.files[0])
                      setMsg(null)
                    }
                  }}
                />
                {audioFile ? (
                  <div>
                    <div style={{ fontSize:'20px', color:'#1D9E75', marginBottom:'4px' }}>✓</div>
                    <div style={{ fontSize:'12px', color:'#0F6E56', fontWeight:600 }}>
                      {audioFile.name}
                    </div>
                    <div style={{ fontSize:'11px', color:'#1D9E75', marginTop:'2px' }}>
                      {(audioFile.size / 1024).toFixed(0)} KB · Click to change
                    </div>
                  </div>
                ) : (
                  <div>
                    <div style={{ fontSize:'22px', color:'#D3D1C7', marginBottom:'4px' }}>↑</div>
                    <div style={{ fontSize:'12px', color:'#888780' }}>
                      Click to select WAV / MP3 / M4A
                    </div>
                    <div style={{ fontSize:'11px', color:'#B4B2A9', marginTop:'2px' }}>
                      WhatsApp voice note or any audio recording
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Tips */}
            <div style={{ background:'#E6F1FB', border:'0.5px solid #B5D4F4',
              borderRadius:'8px', padding:'12px 14px', fontSize:'11px',
              color:'#0C447C', lineHeight:1.7 }}>
              <strong>Tips for good enrollment:</strong><br/>
              · Record officer speaking for 10–30 seconds<br/>
              · Use any WhatsApp voice note or phone recording<br/>
              · The audio trains the AI to recognize this officer's voice<br/>
              · More audio = better detection accuracy
            </div>

            {/* Message */}
            {msg && (
              <div style={{
                background: msgStyle[msg.type]?.bg || '#F8F7F4',
                border: `0.5px solid ${msgStyle[msg.type]?.border || '#D3D1C7'}`,
                borderRadius:'8px', padding:'12px 14px', fontSize:'12px',
                color: msgStyle[msg.type]?.color || '#5F5E5A',
                lineHeight:1.5
              }}>
                {msg.text}
              </div>
            )}

            {/* Submit button */}
            <button
              onClick={enroll}
              disabled={enrolling}
              style={{ padding:'13px', display:'flex', alignItems:'center',
                justifyContent:'center', gap:'8px',
                background: enrolling ? '#F8F7F4' : '#185FA5',
                color: enrolling ? '#B4B2A9' : '#fff',
                border: `0.5px solid ${enrolling ? '#D3D1C7' : '#185FA5'}`,
                borderRadius:'10px', fontSize:'14px', fontWeight:700,
                cursor: enrolling ? 'not-allowed' : 'pointer',
                transition:'all .2s', width:'100%' }}>
              {enrolling
                ? <><Spinner size={16}/> Building voice fingerprint...</>
                : '◎  Enroll Officer'
              }
            </button>

          </div>
        </div>
      </div>

      {/* Info */}
      <div style={{ marginTop:'16px', background:'#F8F7F4', border:'0.5px solid #E8E6DF',
        borderRadius:'10px', padding:'16px 18px', fontSize:'11px',
        color:'#888780', lineHeight:1.8 }}>
        <span style={{ ...LABEL, marginBottom:'6px' }}>How Voice Enrollment Works</span>
        The system extracts a <strong style={{ color:'#2C2C2A' }}>106-dimensional MFCC voiceprint</strong> from
        the enrollment audio — capturing the officer's unique vocal characteristics (pitch, rhythm, frequency patterns).
        During body cam analysis, every 2-second window is compared against this fingerprint.
        Segments scoring above <strong style={{ color:'#2C2C2A' }}>0.82 cosine similarity</strong> are
        identified as the enrolled officer and analyzed for violations.
      </div>
    </div>
  )
}