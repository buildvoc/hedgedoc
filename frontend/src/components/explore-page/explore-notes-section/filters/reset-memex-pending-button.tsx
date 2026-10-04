'use client'

import React, { useState } from 'react'
import { Dropdown } from 'react-bootstrap'
import { ArrowCounterclockwise as IconReset } from 'react-bootstrap-icons'
import { UiIcon } from '../../../common/icons/ui-icon'

export const ResetMemexPendingButton: React.FC = () => {
  const [state, setState] =
    useState<'idle' | 'resetting' | 'done' | 'error'>('idle')
  const [count, setCount] = useState(0)

  const resetPending = async () => {
    if (state === 'resetting') return

    const confirmed = window.confirm(
      'Force all currently pending Memex items to reprocess even when their HedgeDoc revision is unchanged?'
    )

    if (!confirmed) return

    setState('resetting')

    try {
      const response = await fetch('/memex-queue', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          action: 'reset-pending'
        })
      })

      const data = (await response.json()) as {
        reset?: boolean
        count?: number
        error?: string
      }

      if (!response.ok) {
        throw new Error(data.error ?? `Memex queue HTTP ${response.status}`)
      }

      setCount(data.count ?? 0)
      setState('done')
    } catch (error) {
      console.error('Failed to reset Memex pending items', error)
      setState('error')
    }
  }

  const label =
    state === 'resetting'
      ? 'Resetting…'
      : state === 'done'
        ? `Reprocess enabled (${count})`
        : state === 'error'
          ? 'Reset failed — retry'
          : 'Reset Pending for Reprocess'

  return (
    <Dropdown.Item
      disabled={state === 'resetting'}
      onClick={() => void resetPending()}>
      <UiIcon icon={IconReset} />
      <span className='ms-2'>{label}</span>
    </Dropdown.Item>
  )
}
