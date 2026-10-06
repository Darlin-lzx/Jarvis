import { useState, useEffect } from 'react'

export function useHealth(intervalMs = 10000) {
  const [healthy, setHealthy] = useState(false)

  useEffect(() => {
    let mounted = true
    const check = async () => {
      try {
        const res = await fetch('/api/health')
        const data = await res.json()
        if (mounted) setHealthy(data?.status === 'ok')
      } catch { if (mounted) setHealthy(false) }
    }
    check()
    const id = setInterval(check, intervalMs)
    return () => { mounted = false; clearInterval(id) }
  }, [intervalMs])

  return healthy
}
