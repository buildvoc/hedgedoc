'use client'

import React, { useEffect, useRef, useState } from 'react'
import { Button, Dropdown } from 'react-bootstrap'
import { PlayFill as IconPlay } from 'react-bootstrap-icons'
import { UiIcon } from '../../../common/icons/ui-icon'

interface ProcessMemexQueueButtonProps {
  asMenuItem?: boolean
  onStart?: () => void
}

export const ProcessMemexQueueButton: React.FC<ProcessMemexQueueButtonProps> = ({
  asMenuItem = false,
  onStart
}) => {
  const [state, setState] =
    useState<'idle' | 'starting' | 'running'>('idle')

  const startedHere = useRef(false)

  useEffect(() => {
    let active = true

    const poll = async () => {
      try {
        const response = await fetch('/memex-process', {
          method: 'GET',
          cache: 'no-store'
        })

        if (!response.ok) return

        const data = (await response.json()) as { running?: boolean }

        if (!active) return

        if (data.running) {
          setState('running')
          return
        }

        setState('idle')

        if (startedHere.current) {
          startedHere.current = false
          window.location.reload()
        }
      } catch (error) {
        console.error('Failed to check Memex processor', error)
      }
    }

    void poll()

    const timer = window.setInterval(() => {
      void poll()
    }, 2000)

    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  const processQueue = async () => {
    if (state !== 'idle') return

    onStart?.()
    setState('starting')

    try {
      const response = await fetch('/memex-process', {
        method: 'POST'
      })

      if (!response.ok) {
        throw new Error(`Memex processor HTTP ${response.status}`)
      }

      startedHere.current = true
      setState('running')
    } catch (error) {
      console.error('Failed to start Memex processor', error)
      setState('idle')
    }
  }

  const label =
    state === 'starting' ? 'Starting…' : state === 'running' ? 'Processing…' : 'Process Pending'

  if (asMenuItem) {
    return (
      <Dropdown.Item disabled={state !== 'idle'} onClick={() => void processQueue()}>
        <UiIcon icon={IconPlay} />
        <span className='ms-2'>{label}</span>
      </Dropdown.Item>
    )
  }

  return (
    <Button
      variant='success'
      disabled={state !== 'idle'}
      onClick={() => void processQueue()}>
      <UiIcon icon={IconPlay} />
      <span className='ms-1'>{label}</span>
    </Button>
  )
}
