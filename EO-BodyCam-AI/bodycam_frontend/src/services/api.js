import axios from 'axios'

// ── Python (Flask + SocketIO) backend at :5050 — Whisper + SVM pipeline ──
const BASE = import.meta.env.VITE_API_URL || 'http://localhost:5050'

const api = axios.create({
  baseURL: BASE,
  timeout: 120000,  // 2 minutes — enrollment audio can be large
})

// ── .NET (Gemini-powered) backend at :8080 — multimodal video + audio ──
// Uses gemini-2.5-flash-lite by default, returns the same snake_case JSON
// shape the Upload page renders (see PERA360.Shared.Contracts.AnalyseVideoResponse).
const DOTNET_BASE = import.meta.env.VITE_DOTNET_API_URL || 'http://localhost:8080'

const dotnetApi = axios.create({
  baseURL: DOTNET_BASE,
  timeout: 600000,  // 10 minutes — Gemini can take a while on full videos
})

export const ApiService = {
  health:        ()             => api.get('/api/health'),
  getOfficers:   ()             => api.get('/api/officers'),
  getSamples:    ()             => api.get('/api/samples'),
  getKeywords:   ()             => api.get('/api/keywords'),
  getIncidents:  (p = {})       => api.get('/api/incidents', { params: p }),
  getIncident:   (id)           => api.get(`/api/incidents/${id}`),
  getDashboard:  ()             => api.get('/api/dashboard/stats'),

  analyzeSample: (filename, oid = 'EO_001') =>
    api.post('/api/analyze/sample', { filename, officer_id: oid }),

  analyzeUpload: (file, oid, opts = {}) => {
    const { onUploadProgress, signal } = opts
    const form = new FormData()
    form.append('audio',      file)
    form.append('officer_id', oid)
    return api.post('/api/analyze/upload', form, {
      timeout: 600000,  // 10 minutes — long bodycam clips with full Gemini analysis
      onUploadProgress,
      signal,
    })
  },

  sendChunk: (blob, oid, sid, idx) => {
    const form = new FormData()
    form.append('audio',       blob, 'chunk.webm')
    form.append('officer_id',  oid)
    form.append('session_id',  sid)
    form.append('chunk_index', idx)
    return api.post('/api/livestream/chunk', form)
  },

  enrollOfficer: (oid, name, area, file) => {
    const form = new FormData()
    form.append('officer_id', oid)
    form.append('name',       name)
    form.append('area',       area || '')
    form.append('audio',      file, file.name || 'enrollment.wav')
    return api.post('/api/officers/enroll', form, {
      timeout: 120000,  // 2 minutes for enrollment
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },

  // ── .NET / Gemini multimodal endpoint ─────────────────────────────
  // POST /api/analyse  (multipart)  field "video" = file, "officerId"
  // Response is the snake_case AnalyseVideoResponse shape that the
  // existing Upload-style ResultPanel knows how to render.
  analyseGemini: (file, oid, stationId = '') => {
    const form = new FormData()
    form.append('video',     file)        // .NET expects "video" (any media file)
    form.append('officerId', oid)         // camelCase per [FromForm(Name="officerId")]
    if (stationId) form.append('stationId', stationId)
    return dotnetApi.post('/api/analyse', form)
  },

  geminiHealth: () => dotnetApi.get('/api/analyse/health'),

  // ── Watch-folder auto-analysis (drop video → backend analyzes) ────
  // Lightweight polls — short timeout so a stuck backend can never pile up.
  watchStatus:  (opts = {})              => api.get('/api/watch/status',          { timeout: 10000, ...opts }),
  watchList:    (params = {}, opts = {}) => api.get('/api/watch/list',            { params, timeout: 10000, ...opts }),
  watchResult:  (fileId, opts = {})      => api.get(`/api/watch/result/${fileId}`,{ timeout: 15000, ...opts }),
  watchRescan:  ()                       => api.post('/api/watch/rescan',  null,  { timeout: 10000 }),
  watchDelete:  (fileId)                 => api.delete(`/api/watch/result/${fileId}`, { timeout: 10000 }),
  watchConfig:  (cfg)                    => api.post('/api/watch/config',  cfg,   { timeout: 10000 }),
}

export default ApiService
