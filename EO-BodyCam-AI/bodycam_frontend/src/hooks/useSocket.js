import { useEffect, useState, useRef } from 'react'
import { io } from 'socket.io-client'

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:5050'

export function useSocket() {
  const [connected,  setConnected]  = useState(false)
  const [alerts,     setAlerts]     = useState([])
  const [liveStatus, setLiveStatus] = useState(null)
  const ref = useRef(null)

  useEffect(() => {
    const s = io(BASE, { transports: ['websocket', 'polling'] })
    ref.current = s
    s.on('connect',    () => { setConnected(true); s.emit('join_supervisor', {}) })
    s.on('disconnect', () => setConnected(false))
    s.on('violation_alert', d => {
      setAlerts(p => [{ ...d, _id: Date.now(), read: false }, ...p.slice(0, 49)])
      if (Notification.permission === 'granted' && d.severity === 'CRITICAL')
        new Notification(`CRITICAL — ${d.officer_id}`, { body: `Score: ${d.total_score}/100` })
    })
    s.on('analysis_progress', d => setLiveStatus(d))
    if (Notification.permission === 'default') Notification.requestPermission()
    return () => s.disconnect()
  }, [])

  const markRead    = id => setAlerts(p => p.map(a => a._id === id ? { ...a, read: true } : a))
  const clearAlerts = ()  => setAlerts([])

  return { connected, alerts, liveStatus, markRead, clearAlerts }
}