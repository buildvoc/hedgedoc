'use client'

import React, { useCallback, useState } from 'react'
import { Button, Spinner } from 'react-bootstrap'

export const ProcessMemexOrphansButton: React.FC = () => {
  const [running, setRunning] = useState(false)

  const processOrphans = useCallback(async () => {
    setRunning(true)

    try {
      const response = await fetch('/memex-orphans', { method: 'POST' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      for (let i = 0; i < 180; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2000))

        const check = await fetch('/memex-orphans', { cache: 'no-store' })
        const data = (await check.json()) as { running?: boolean }

        if (!data.running) {
          window.location.reload()
          return
        }
      }
    } finally {
      setRunning(false)
    }
  }, [])

  return (
    <Button size='sm' variant='warning' disabled={running} onClick={processOrphans}>
      {running && <Spinner animation='border' size='sm' className='me-1' />}
      {running ? 'Repairing…' : 'Process Orphans'}
    </Button>
  )
}
