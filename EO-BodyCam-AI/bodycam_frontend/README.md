# EO Bodycam AI — Frontend

## Setup

```bash
npm install
npm run dev
# Opens at http://localhost:3000
```

## Build for production

```bash
npm run build
# Output in dist/
```

## Pages

| Route | Page | Description |
|-------|------|-------------|
| / | Dashboard | Stats, charts, recent incidents |
| /upload | Upload | Drag-drop audio upload + full analysis |
| /live | Live Stream | Real-time body cam / mobile streaming |
| /samples | Test Samples | 13 built-in samples to test instantly |
| /incidents | Incidents | All violation incidents with filters |
| /officers | Officers | Enroll officers, manage voiceprints |

## Environment

Create `.env` if backend is not on localhost:

```
VITE_API_URL=http://your-server:5050
```

## Tech Stack

- React 18 + Vite
- React Router v6
- Tailwind CSS
- Recharts (charts)
- Socket.IO client (live alerts)
- Axios (API calls)

## Live Stream

The Live Stream page uses the browser's `MediaRecorder` API to capture
audio in 5-second chunks and POST them to `/api/livestream/chunk`.

For actual body cam integration:
1. Stream the body cam audio via RTSP or HTTP
2. Capture 5s chunks in Python/FFmpeg
3. POST each chunk to `/api/livestream/chunk`
4. Results appear in real time on the frontend

## WebSocket Alerts

The frontend connects to Socket.IO at startup. When the backend detects a
CRITICAL or WARNING violation, it pushes a `violation_alert` event that
appears as a banner in the sidebar and Incidents page.
